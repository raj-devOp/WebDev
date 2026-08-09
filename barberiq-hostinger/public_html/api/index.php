<?php
/**
 * API front controller.
 *
 * Everything under /api/ routes through here. The .htoaccess in public_html
 * rewrites /api/wallet/12 to /api/index.php?route=wallet/12, so the browser
 * URLs stay identical to the Node build and the frontend needed no changes.
 *
 * If mod_rewrite is unavailable the client falls back to calling
 * /api/index.php?route=... directly — see js/api.js. Both work.
 */

declare(strict_types=1);

// Buffer everything. biq_json() discards whatever collected here, so a stray
// notice or a blank line after a closing PHP tag cannot corrupt the JSON body.
ob_start();

require __DIR__ . '/lib/helpers.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/intelligence.php';
require __DIR__ . '/lib/auth.php';

$config = biq_config();
date_default_timezone_set('UTC'); // all storage in UTC; display is localised client-side

if (!empty($config['debug'])) {
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
} else {
    ini_set('display_errors', '0');
}

// Any uncaught error becomes JSON, so the client never has to parse an HTML
// error page out of a failed fetch.
set_exception_handler(function (Throwable $e) use ($config) {
    error_log('BarberIQ error: ' . $e->getMessage());
    $detail = !empty($config['debug']) ? ' — ' . $e->getMessage() : '';
    biq_fail('Something went wrong on the server.' . $detail, 500);
});

// ---------------------------------------------------------------------------
// Resolve the route
// ---------------------------------------------------------------------------
$route = $_GET['route'] ?? '';
if ($route === '' && isset($_SERVER['PATH_INFO'])) {
    $route = ltrim($_SERVER['PATH_INFO'], '/');
}
$route = trim(preg_replace('#[^a-zA-Z0-9/_\-]#', '', (string) $route), '/');
$parts  = $route === '' ? [] : explode('/', $route);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$seg = fn(int $i) => $parts[$i] ?? null;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
switch ($seg(0)) {

    // ===================================================== BOOTSTRAP / SESSION
    case 'bootstrap':
        require __DIR__ . '/routes/bootstrap.php';
        biq_route_bootstrap();
        break;

    case 'session':
        require __DIR__ . '/routes/session.php';
        if ($seg(1) === 'login'  && $method === 'POST') { biq_route_login();  }
        elseif ($seg(1) === 'logout' && $method === 'POST') { biq_route_logout(); }
        elseif ($seg(1) === null && $method === 'GET') { biq_route_session(); }
        else { biq_fail('Unknown session route.', 404); }
        break;

    // ================================================================= WALLET
    case 'wallet':
        require __DIR__ . '/routes/wallet.php';
        $cid = biq_int($seg(1));
        if ($cid === null) {
            biq_fail('A valid customer id is required.');
        }
        if ($seg(2) === 'topup' && $method === 'POST') { biq_route_topup($cid); }
        elseif ($seg(2) === null && $method === 'GET') { biq_route_wallet($cid); }
        else { biq_fail('Unknown wallet route.', 404); }
        break;

    // ============================================================== CATALOGUE
    case 'catalogue':
        require __DIR__ . '/routes/catalogue.php';
        biq_route_catalogue();
        break;

    case 'addons':
        require __DIR__ . '/routes/catalogue.php';
        if ($seg(1) === 'recommend') { biq_route_recommend(); }
        else { biq_fail('Unknown add-on route.', 404); }
        break;

    case 'slots':
        require __DIR__ . '/routes/catalogue.php';
        biq_route_slots();
        break;

    // ============================================================== BOOKINGS
    case 'bookings':
        require __DIR__ . '/routes/booking.php';
        if ($seg(1) === null && $method === 'POST') {
            biq_route_create_booking();
        } elseif ($seg(2) === 'cancel' && $method === 'POST') {
            biq_route_cancel_booking((int) biq_int($seg(1)));
        } elseif ($seg(2) === 'complete' && $method === 'POST') {
            biq_route_complete_booking((int) biq_int($seg(1)));
        } elseif ($seg(1) !== null && $method === 'GET') {
            biq_route_list_bookings((int) biq_int($seg(1)));
        } else {
            biq_fail('Unknown booking route.', 404);
        }
        break;

    // ============================================================= REMINDERS
    case 'reminders':
        require __DIR__ . '/routes/reminders.php';
        if ($seg(1) === 'rebuild' && $method === 'POST') {
            biq_route_rebuild_reminders();
        } elseif ($seg(2) === 'action' && $method === 'POST') {
            biq_route_reminder_action((int) biq_int($seg(1)));
        } elseif ($seg(2) === 'preferences' && $method === 'PUT') {
            biq_route_reminder_prefs((int) biq_int($seg(1)));
        } elseif ($seg(1) !== null && $method === 'GET') {
            biq_route_reminders((int) biq_int($seg(1)));
        } else {
            biq_fail('Unknown reminder route.', 404);
        }
        break;

    // ============================================================== REFERRAL
    case 'referral':
        require __DIR__ . '/routes/referral.php';
        if ($seg(2) === 'invite' && $method === 'POST') {
            biq_route_invite((int) biq_int($seg(1)));
        } elseif ($seg(2) === 'simulate-signup' && $method === 'POST') {
            biq_route_simulate_signup((int) biq_int($seg(1)));
        } elseif ($seg(1) !== null && $method === 'GET') {
            biq_route_referral((int) biq_int($seg(1)));
        } else {
            biq_fail('Unknown referral route.', 404);
        }
        break;

    // ============================================================= DASHBOARD
    // Owner-only. Without this gate your takings, customer names and phone
    // numbers are readable by anyone who guesses the URL.
    case 'dashboard':
        biq_require_owner();
        require __DIR__ . '/routes/dashboard.php';
        switch ($seg(1)) {
            case null:        biq_route_dashboard();          break;
            case 'barbers':   biq_route_dash_barbers();       break;
            case 'customers': biq_route_dash_customers();     break;
            case 'winback':   biq_route_dash_winback();       break;
            case 'addons':    biq_route_dash_addons();        break;
            case 'insights':  biq_route_dash_insights();      break;
            default:          biq_fail('Unknown dashboard route.', 404);
        }
        break;

    // ================================================================= ADMIN
    case 'admin':
        require __DIR__ . '/routes/admin.php';
        if ($seg(1) === 'health') {
            biq_route_health();
        } elseif ($seg(1) === 'reseed' && $method === 'POST') {
            biq_require_owner();
            biq_route_reseed();
        } else {
            biq_fail('Unknown admin route.', 404);
        }
        break;

    default:
        biq_fail(
            'No such endpoint. The API lives under /api/ — try /api/admin/health.',
            404
        );
}
