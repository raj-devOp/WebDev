<?php
/**
 * Owner authentication.
 *
 * The Node build had no login because it ran on localhost. Once this is on a
 * public domain that is a real hole: the dashboard exposes takings, the full
 * customer list, phone numbers and email addresses. So the owner routes sit
 * behind a password.
 *
 * Deliberately simple — one shared owner password, PHP session, no user table.
 * A single-shop tool does not need role management, and every extra moving part
 * is another thing to explain to a barber. When you sell to multi-site groups,
 * replace this with per-user accounts.
 *
 * Set the hash in config.php:
 *   php -r "echo password_hash('your-password', PASSWORD_DEFAULT);"
 */

declare(strict_types=1);

function biq_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => 'Lax',
        // Only send the cookie over HTTPS when the request itself is HTTPS,
        // otherwise login breaks on a plain-http staging URL.
        'secure'   => (($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off')
                      || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'),
    ]);
    session_name('barberiq_session');
    session_start();
}

/** Is a password configured at all? */
function biq_owner_gate_enabled(): bool
{
    $hash = biq_config()['owner_password_hash'] ?? '';
    return is_string($hash) && $hash !== '';
}

function biq_is_owner(): bool
{
    if (!biq_owner_gate_enabled()) {
        return true; // gate disabled — see the warning in config.sample.php
    }
    biq_session_start();
    return !empty($_SESSION['biq_owner']);
}

/** Stop the request unless the caller is the owner. */
function biq_require_owner(): void
{
    if (biq_is_owner()) {
        return;
    }
    biq_json([
        'error' => 'Owner password required.',
        'auth_required' => true,
    ], 401);
}

function biq_owner_login(string $password): bool
{
    $hash = biq_config()['owner_password_hash'] ?? '';
    if (!is_string($hash) || $hash === '') {
        return true;
    }
    // password_verify is constant-time, so a wrong password cannot be timed.
    if (!password_verify($password, $hash)) {
        // Slow down brute force a little without blocking the whole server.
        usleep(300000);
        return false;
    }
    biq_session_start();
    session_regenerate_id(true); // prevents session fixation
    $_SESSION['biq_owner'] = true;
    $_SESSION['biq_login_at'] = time();
    return true;
}

function biq_owner_logout(): void
{
    biq_session_start();
    $_SESSION = [];
    session_destroy();
}
