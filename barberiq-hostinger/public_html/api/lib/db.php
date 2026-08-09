<?php
/**
 * Database access and small query helpers.
 *
 * PDO with prepared statements throughout — every value that reaches SQL is
 * bound, never interpolated. On shared hosting your app is one of many on the
 * box, so this is not optional hygiene.
 */

declare(strict_types=1);

function biq_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $path = __DIR__ . '/../config.php';
    if (!is_file($path)) {
        biq_fail(
            'Not installed yet. Open /install/ in your browser to set up the database.',
            503
        );
    }
    $config = require $path;
    if (!is_array($config)) {
        biq_fail('config.php did not return an array. Compare it with config.sample.php.', 500);
    }
    return $config;
}

function biq_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $c = biq_config();
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $c['db_host'],
        (int) ($c['db_port'] ?? 3306),
        $c['db_name']
    );
    try {
        $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepared statements, not driver-side emulation. Emulation
            // returns every column as a string, which quietly turns integer
            // pence into "2200" and breaks arithmetic in the models.
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::ATTR_STRINGIFY_FETCHES  => false,
        ]);
    } catch (PDOException $e) {
        $detail = (biq_config()['debug'] ?? false) ? ' — ' . $e->getMessage() : '';
        biq_fail('Cannot connect to the database. Check the values in api/config.php.' . $detail, 500);
    }
    // Session timezone fixed to UTC so DATETIME comparisons and NOW() agree
    // with what the app writes, whatever the server default happens to be.
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}

/** Run a query and return all rows. */
function biq_all(string $sql, array $params = []): array
{
    $st = biq_db()->prepare($sql);
    $st->execute($params);
    return $st->fetchAll();
}

/** Run a query and return the first row, or null. */
function biq_one(string $sql, array $params = []): ?array
{
    $st = biq_db()->prepare($sql);
    $st->execute($params);
    $row = $st->fetch();
    return $row === false ? null : $row;
}

/** Run a query and return the first column of the first row. */
function biq_val(string $sql, array $params = [])
{
    $st = biq_db()->prepare($sql);
    $st->execute($params);
    $v = $st->fetchColumn();
    return $v === false ? null : $v;
}

/** Execute a write and return the number of affected rows. */
function biq_exec(string $sql, array $params = []): int
{
    $st = biq_db()->prepare($sql);
    $st->execute($params);
    return $st->rowCount();
}

/** Execute an INSERT and return the new id. */
function biq_insert(string $sql, array $params = []): int
{
    $st = biq_db()->prepare($sql);
    $st->execute($params);
    return (int) biq_db()->lastInsertId();
}

/**
 * Run a closure inside a transaction, rolling back on any exception.
 *
 * Everything that moves money goes through this. A wallet debit and the
 * booking it pays for are one unit of work: if the slot turns out to be taken,
 * the debit must not survive.
 */
function biq_transaction(callable $fn)
{
    $db = biq_db();
    $db->beginTransaction();
    try {
        $result = $fn($db);
        $db->commit();
        return $result;
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}
