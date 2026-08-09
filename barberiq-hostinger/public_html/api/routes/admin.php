<?php
/** Health check and demo reset. */

declare(strict_types=1);

function biq_route_health(): void
{
    $tables = [
        'shops', 'barbers', 'customers', 'services', 'addons', 'appointments',
        'appointment_addons', 'wallet_accounts', 'wallet_transactions',
        'referrals', 'reminders', 'plans', 'topup_tiers',
    ];
    $counts = [];
    foreach ($tables as $t) {
        // Table names are from this fixed whitelist, never from user input.
        $counts[$t] = (int) biq_val("SELECT COUNT(*) FROM `$t`");
    }
    biq_json([
        'ok' => true,
        'php' => PHP_VERSION,
        'mysql' => biq_val('SELECT VERSION()'),
        'counts' => $counts,
    ]);
}

function biq_route_reseed(): void
{
    if (empty(biq_config()['demo_mode'])) {
        biq_fail('Demo controls are disabled on this installation.', 403);
    }
    require __DIR__ . '/../lib/seed.php';
    $result = biq_seed_all();
    biq_json(['ok' => true, 'message' => 'Demo data regenerated.', 'counts' => $result]);
}
