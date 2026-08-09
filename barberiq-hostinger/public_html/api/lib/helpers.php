<?php
/**
 * Shared helpers: JSON output, input validation, money and date formatting.
 */

declare(strict_types=1);

const BIQ_SHOP_ID = 1; // single-tenant install; the schema is multi-tenant ready

/**
 * Send a JSON response and stop.
 *
 * Any buffered output is discarded first. Shared hosting often has
 * display_errors on, and a single PHP notice printed ahead of the body makes
 * the response unparseable to the client — the symptom is a screen that just
 * says "failed to load" with a perfectly healthy server behind it. Throwing
 * away stray output means one bad notice degrades a log line, not the app.
 */
function biq_json($data, int $status = 200): void
{
    while (ob_get_level() > 0) {
        $stray = ob_get_clean();
        if ($stray !== false && trim($stray) !== '') {
            error_log('BarberIQ: discarded unexpected output before JSON: ' . substr($stray, 0, 500));
        }
    }
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Send an error and stop. The client shows `error` to the user verbatim. */
function biq_fail(string $message, int $status = 400): void
{
    biq_json(['error' => $message], $status);
}

/** Decoded JSON request body. */
function biq_body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return $body = [];
    }
    $decoded = json_decode($raw, true);
    return $body = is_array($decoded) ? $decoded : [];
}

/** Strict integer coercion — returns null for anything non-numeric. */
function biq_int($value): ?int
{
    if (is_int($value)) {
        return $value;
    }
    if (is_string($value) && preg_match('/^-?\d+$/', trim($value))) {
        return (int) trim($value);
    }
    if (is_float($value) && floor($value) === $value) {
        return (int) $value;
    }
    return null;
}

function biq_str($value, int $maxLen = 255): string
{
    return mb_substr(trim((string) $value), 0, $maxLen);
}

function biq_money(int $pence): string
{
    return '£' . number_format($pence / 100, 2);
}

/** Current UTC time as a MySQL DATETIME string. */
function biq_now(): string
{
    return gmdate('Y-m-d H:i:s');
}

function biq_date_add(string $datetime, int $days): string
{
    return gmdate('Y-m-d H:i:s', strtotime($datetime . ' UTC') + $days * 86400);
}

/** Whole days between two datetimes (b - a), floored. */
function biq_days_between(string $a, string $b): int
{
    return (int) floor((strtotime($b . ' UTC') - strtotime($a . ' UTC')) / 86400);
}

function biq_clamp(float $v, float $lo, float $hi): float
{
    return max($lo, min($hi, $v));
}

function biq_median(array $xs): float
{
    if (!$xs) {
        return 0.0;
    }
    sort($xs);
    $n = count($xs);
    $mid = intdiv($n, 2);
    return $n % 2 ? (float) $xs[$mid] : (($xs[$mid - 1] + $xs[$mid]) / 2);
}

/**
 * Fetch a customer scoped to this shop, or fail with 404.
 */
function biq_require_customer($id): array
{
    $cid = biq_int($id);
    if ($cid === null) {
        biq_fail('A valid customer id is required.');
    }
    $c = biq_one('SELECT * FROM customers WHERE id = ? AND shop_id = ?', [$cid, BIQ_SHOP_ID]);
    if (!$c) {
        biq_fail('Customer not found.', 404);
    }
    return $c;
}

/** Get or lazily create a customer's wallet. */
function biq_wallet_of(int $customerId): array
{
    $w = biq_one('SELECT * FROM wallet_accounts WHERE customer_id = ?', [$customerId]);
    if ($w) {
        return $w;
    }
    biq_insert('INSERT INTO wallet_accounts (customer_id) VALUES (?)', [$customerId]);
    return biq_one('SELECT * FROM wallet_accounts WHERE customer_id = ?', [$customerId]);
}

/**
 * Generate a shareable referral code.
 *
 * Excludes I, O, 0 and 1 so a code can be read aloud across a counter without
 * being misheard.
 */
function biq_code(int $len = 6): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < $len; $i++) {
        $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $out;
}

/** Cast the numeric columns MySQL hands back as strings in some configs. */
function biq_numeric(array $row, array $intCols = [], array $floatCols = []): array
{
    foreach ($intCols as $c) {
        if (array_key_exists($c, $row) && $row[$c] !== null) {
            $row[$c] = (int) $row[$c];
        }
    }
    foreach ($floatCols as $c) {
        if (array_key_exists($c, $row) && $row[$c] !== null) {
            $row[$c] = (float) $row[$c];
        }
    }
    return $row;
}
