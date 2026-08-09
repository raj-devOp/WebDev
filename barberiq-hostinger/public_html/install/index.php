<?php
/**
 * BarberIQ web installer.
 *
 * Three steps: check the server, take database credentials, then create the
 * tables and generate a year of demo data. Writes api/config.php for you.
 *
 * DELETE THIS FOLDER once you are done. It can wipe your database.
 */

declare(strict_types=1);
error_reporting(E_ALL);
ini_set('display_errors', '1');
session_start();

$root = dirname(__DIR__);
$configPath = $root . '/api/config.php';
$step = $_GET['step'] ?? '1';
$errors = [];
$notices = [];

// ---------------------------------------------------------------------------
// Step 2 handler: test credentials and write config.php
// ---------------------------------------------------------------------------
if (($_POST['action'] ?? '') === 'save_config') {
    $host = trim($_POST['db_host'] ?? 'localhost');
    $name = trim($_POST['db_name'] ?? '');
    $user = trim($_POST['db_user'] ?? '');
    $pass = (string) ($_POST['db_pass'] ?? '');
    $port = (int) ($_POST['db_port'] ?? 3306);
    $ownerPass = (string) ($_POST['owner_pass'] ?? '');

    if ($name === '' || $user === '') {
        $errors[] = 'Database name and username are both required.';
    }
    if (strlen($ownerPass) > 0 && strlen($ownerPass) < 8) {
        $errors[] = 'The owner password needs to be at least 8 characters.';
    }

    if (!$errors) {
        try {
            $pdo = new PDO(
                "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4",
                $user,
                $pass,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );
            $version = $pdo->query('SELECT VERSION()')->fetchColumn();

            $config = "<?php\n"
                . "/**\n * BarberIQ configuration — written by the installer.\n */\n\n"
                . "return [\n"
                . "    'db_host' => " . var_export($host, true) . ",\n"
                . "    'db_name' => " . var_export($name, true) . ",\n"
                . "    'db_user' => " . var_export($user, true) . ",\n"
                . "    'db_pass' => " . var_export($pass, true) . ",\n"
                . "    'db_port' => " . $port . ",\n\n"
                . "    // Owner dashboard password hash. Empty = no password (not advised).\n"
                . "    'owner_password_hash' => "
                . var_export($ownerPass === '' ? '' : password_hash($ownerPass, PASSWORD_DEFAULT), true) . ",\n\n"
                . "    'timezone'  => 'Europe/London',\n"
                . "    // Demo mode enables the persona switcher and reset button.\n"
                . "    // Set to false once a real shop is using this.\n"
                . "    'demo_mode' => true,\n"
                . "    'debug'     => false,\n"
                . "];\n";

            if (@file_put_contents($configPath, $config) === false) {
                $errors[] = 'Could not write api/config.php. In hPanel File Manager, set the '
                    . '/api folder permissions to 755 and try again.';
            } else {
                $_SESSION['biq_install_ok'] = true;
                header('Location: ?step=3');
                exit;
            }
        } catch (PDOException $e) {
            $errors[] = 'Could not connect: ' . $e->getMessage();
            $errors[] = 'Check the values against hPanel → Databases → MySQL Databases. '
                . 'On Hostinger the host is normally "localhost" and the names start with your '
                . 'account id, like u123456789_barberiq.';
        }
    }
    $step = '2';
}

// ---------------------------------------------------------------------------
// Step 3 handler: build schema + seed
// ---------------------------------------------------------------------------
$result = null;
if (($_POST['action'] ?? '') === 'run_install') {
    $step = '3';
    if (!is_file($configPath)) {
        $errors[] = 'config.php is missing — go back to step 2.';
    } else {
        try {
            require $root . '/api/lib/helpers.php';
            require $root . '/api/lib/db.php';
            require $root . '/api/lib/intelligence.php';

            $sql = file_get_contents(__DIR__ . '/schema.sql');
            if ($sql === false) {
                throw new RuntimeException('schema.sql is missing from the install folder.');
            }

            $pdo = biq_db();
            // Split on semicolons at end of line. The schema is written so this
            // is safe — no stored procedures or semicolons inside literals.
            foreach (preg_split('/;\s*[\r\n]/', $sql) as $stmt) {
                $stmt = trim($stmt);
                if ($stmt === '' || str_starts_with($stmt, '--')) {
                    continue;
                }
                $pdo->exec($stmt);
            }

            require $root . '/api/lib/seed.php';
            // Generating a year of history is a few seconds locally but slower
            // on shared hosting, and the default 30-second cap would kill it
            // half way through.
            @set_time_limit(300);
            @ini_set('memory_limit', '256M');
            $t0 = microtime(true);
            $result = biq_seed_all();
            $result['seconds'] = round(microtime(true) - $t0, 1);
            $notices[] = 'Installed successfully.';
        } catch (Throwable $e) {
            $errors[] = 'Install failed: ' . $e->getMessage();
        }
    }
}

$phpOk      = version_compare(PHP_VERSION, '8.0.0', '>=');
$pdoOk      = extension_loaded('pdo_mysql');
$jsonOk     = extension_loaded('json');
$mbOk       = extension_loaded('mbstring');
$writableOk = is_writable($root . '/api');
$allOk      = $phpOk && $pdoOk && $jsonOk && $mbOk;
$hasConfig  = is_file($configPath);
?>
<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BarberIQ installer</title>
<style>
  :root{
    --bg:#0B0C0E;--card:#14161A;--card2:#1B1E23;--fg:#F4F1EA;--muted:#A2A8B3;
    --brass:#D9A93B;--ok:#34C77B;--bad:#F0575C;--warn:#E8A33D;--border:rgba(255,250,240,.12);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;padding:28px 16px}
  .wrap{max-width:680px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:8px}
  .mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-size:23px;
    background:repeating-linear-gradient(135deg,rgba(255,255,255,.22) 0 3px,transparent 3px 7px),
      linear-gradient(135deg,#F0C24E,#D9A93B 50%,#B0842A)}
  h1{font-size:23px;margin:0;letter-spacing:-.02em}
  h2{font-size:17px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-top:18px}
  .steps{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
  .pill{padding:5px 12px;border-radius:99px;font-size:12.5px;font-weight:600;
    background:var(--card2);color:var(--muted);border:1px solid var(--border)}
  .pill.on{background:rgba(217,169,59,.16);color:var(--brass);border-color:transparent}
  .pill.done{background:rgba(52,199,123,.14);color:var(--ok);border-color:transparent}
  .row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
  .row:last-child{border-bottom:0}
  .tag{margin-left:auto;font-weight:700;font-size:12.5px}
  .ok{color:var(--ok)} .bad{color:var(--bad)} .warn{color:var(--warn)}
  label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:5px}
  input{width:100%;padding:10px 12px;border-radius:9px;background:var(--bg);color:var(--fg);
    border:1px solid rgba(255,250,240,.22);font:inherit}
  input:focus{outline:none;border-color:var(--brass);box-shadow:0 0 0 3px rgba(217,169,59,.16)}
  .field{margin-bottom:13px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:13px}
  @media(max-width:560px){.grid2{grid-template-columns:1fr}}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 22px;
    border:0;border-radius:99px;font:inherit;font-weight:700;cursor:pointer;
    background:linear-gradient(135deg,#F0C24E,#D9A93B 50%,#B0842A);color:#1A1204}
  .btn.ghost{background:var(--card2);color:var(--fg);border:1px solid var(--border)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .msg{padding:12px 14px;border-radius:10px;margin-bottom:12px;font-size:13.5px}
  .msg.err{background:rgba(240,87,92,.14);color:#F0575C}
  .msg.good{background:rgba(52,199,123,.14);color:var(--ok)}
  .msg.note{background:rgba(232,163,61,.13);color:var(--warn)}
  code{background:var(--card2);padding:2px 6px;border-radius:5px;font-size:12.5px}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}
  td{padding:6px 0;border-bottom:1px solid var(--border)}
  td:last-child{text-align:right;font-family:ui-monospace,Menlo,monospace;font-weight:600}
  ol{padding-left:20px;color:var(--muted);font-size:13.5px} ol li{margin:6px 0}
  a{color:var(--brass)}
</style>
</head>
<body>
<div class="wrap">

  <div class="brand">
    <div class="mark">💈</div>
    <div>
      <h1>BarberIQ installer</h1>
      <div class="sub">Three steps and you're live</div>
    </div>
  </div>

  <div class="steps">
    <span class="pill <?= $step === '1' ? 'on' : 'done' ?>">1 · Server check</span>
    <span class="pill <?= $step === '2' ? 'on' : ($step === '3' ? 'done' : '') ?>">2 · Database</span>
    <span class="pill <?= $step === '3' ? 'on' : '' ?>">3 · Install</span>
  </div>

  <?php foreach ($errors as $e): ?>
    <div class="msg err">⚠️ <?= htmlspecialchars($e) ?></div>
  <?php endforeach; ?>
  <?php foreach ($notices as $n): ?>
    <div class="msg good">✓ <?= htmlspecialchars($n) ?></div>
  <?php endforeach; ?>

<?php if ($step === '1'): ?>

  <div class="card">
    <h2>Does this server have what we need?</h2>
    <div class="sub">Every Hostinger plan should pass this.</div>
    <div style="margin-top:14px">
      <div class="row"><span>PHP 8.0 or newer</span>
        <span class="tag <?= $phpOk ? 'ok' : 'bad' ?>"><?= PHP_VERSION ?> <?= $phpOk ? '✓' : '✗' ?></span></div>
      <div class="row"><span>MySQL driver (pdo_mysql)</span>
        <span class="tag <?= $pdoOk ? 'ok' : 'bad' ?>"><?= $pdoOk ? 'present ✓' : 'missing ✗' ?></span></div>
      <div class="row"><span>JSON extension</span>
        <span class="tag <?= $jsonOk ? 'ok' : 'bad' ?>"><?= $jsonOk ? 'present ✓' : 'missing ✗' ?></span></div>
      <div class="row"><span>mbstring extension</span>
        <span class="tag <?= $mbOk ? 'ok' : 'bad' ?>"><?= $mbOk ? 'present ✓' : 'missing ✗' ?></span></div>
      <div class="row"><span><code>/api</code> folder writable</span>
        <span class="tag <?= $writableOk ? 'ok' : 'warn' ?>">
          <?= $writableOk ? 'yes ✓' : 'no — set it to 755' ?></span></div>
    </div>

    <?php if (!$allOk): ?>
      <div class="msg err" style="margin-top:14px">
        Something essential is missing. In hPanel → Advanced → PHP Configuration,
        set PHP to 8.1 or newer and enable the extensions listed above.
      </div>
    <?php endif; ?>

    <div style="margin-top:16px">
      <a class="btn <?= $allOk ? '' : 'ghost' ?>" href="?step=2">Continue →</a>
    </div>
  </div>

<?php elseif ($step === '2'): ?>

  <div class="card">
    <h2>Database details</h2>
    <div class="sub">
      From hPanel → Databases → MySQL Databases. Create a database there first if you have not yet.
    </div>

    <?php if ($hasConfig): ?>
      <div class="msg note" style="margin-top:12px">
        A config.php already exists. Submitting this form overwrites it.
      </div>
    <?php endif; ?>

    <form method="post" style="margin-top:16px">
      <input type="hidden" name="action" value="save_config">
      <div class="grid2">
        <div class="field">
          <label>Database host</label>
          <input name="db_host" value="<?= htmlspecialchars($_POST['db_host'] ?? 'localhost') ?>" required>
        </div>
        <div class="field">
          <label>Port</label>
          <input name="db_port" value="<?= htmlspecialchars((string) ($_POST['db_port'] ?? '3306')) ?>">
        </div>
      </div>
      <div class="field">
        <label>Database name</label>
        <input name="db_name" placeholder="u123456789_barberiq"
               value="<?= htmlspecialchars($_POST['db_name'] ?? '') ?>" required>
      </div>
      <div class="field">
        <label>Database username</label>
        <input name="db_user" placeholder="u123456789_barberiq"
               value="<?= htmlspecialchars($_POST['db_user'] ?? '') ?>" required>
      </div>
      <div class="field">
        <label>Database password</label>
        <input name="db_pass" type="password" value="<?= htmlspecialchars($_POST['db_pass'] ?? '') ?>">
      </div>

      <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">

      <div class="field">
        <label>Owner dashboard password (min 8 characters)</label>
        <input name="owner_pass" type="password" placeholder="Choose a password">
        <div class="sub" style="margin-top:6px">
          This protects the owner dashboard, which shows your takings, customer names and
          phone numbers. Anyone who finds the URL can see it without a password. Leave blank
          only if this is a private test URL.
        </div>
      </div>

      <button class="btn" type="submit">Test connection &amp; save →</button>
    </form>
  </div>

<?php else: ?>

  <?php if ($result === null): ?>
    <div class="card">
      <h2>Ready to install</h2>
      <div class="sub">This creates the tables and generates a year of demo trading data.</div>
      <div class="msg note" style="margin-top:14px">
        ⚠️ This <strong>erases everything</strong> in the database you selected. Only continue if
        that database is meant for BarberIQ.
      </div>
      <form method="post">
        <input type="hidden" name="action" value="run_install">
        <button class="btn" type="submit">Create tables &amp; demo data</button>
      </form>
    </div>
  <?php else: ?>
    <div class="card">
      <h2>🎉 Installed</h2>
      <div class="sub">Generated in <?= $result['seconds'] ?> seconds.</div>
      <table>
        <tr><td>Customers</td><td><?= number_format($result['customers']) ?></td></tr>
        <tr><td>Barbers</td><td><?= $result['barbers'] ?></td></tr>
        <tr><td>Appointments</td><td><?= number_format($result['appointments']) ?></td></tr>
        <tr><td>Completed visits</td><td><?= number_format($result['completed']) ?></td></tr>
        <tr><td>Revenue (12 months)</td><td>£<?= number_format($result['revenue_pence'] / 100, 2) ?></td></tr>
        <tr><td>Wallet transactions</td><td><?= number_format($result['wallet_txns']) ?></td></tr>
        <tr><td>Referrals</td><td><?= $result['referrals'] ?></td></tr>
        <tr><td>Reminders scheduled</td><td><?= $result['reminders'] ?></td></tr>
      </table>
    </div>

    <div class="card" style="border-color:var(--bad)">
      <h2 style="color:var(--bad)">One last thing — delete this folder</h2>
      <div class="sub">
        The installer can wipe your database. Leaving it online means anyone who finds
        <span class="mono">/install/</span> can erase your shop's data.
      </div>
      <ol style="margin-top:10px">
        <li>Open hPanel → Files → File Manager</li>
        <li>Go into <code>public_html</code></li>
        <li>Delete the whole <code>install</code> folder</li>
      </ol>
    </div>

    <div class="card">
      <h2>Open your app</h2>
      <div class="sub">Bookmark the owner console — that is the one you demo from.</div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn" href="../">Open the app →</a>
        <a class="btn ghost" href="../#/dashboard">Owner dashboard</a>
        <a class="btn ghost" href="../#/pricing">Pricing screen</a>
      </div>
    </div>
  <?php endif; ?>

<?php endif; ?>

  <p class="sub" style="margin-top:24px;text-align:center">
    Stuck? See <span class="mono">HOSTINGER-DEPLOY.md</span> in the zip for step-by-step help.
  </p>
</div>
</body>
</html>
