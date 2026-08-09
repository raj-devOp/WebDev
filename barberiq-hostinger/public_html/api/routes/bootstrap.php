<?php
/** Everything the client needs on first paint. */

declare(strict_types=1);

function biq_route_bootstrap(): void
{
    $shop = biq_one('SELECT * FROM shops WHERE id = ?', [BIQ_SHOP_ID]);
    if (!$shop) {
        biq_fail('No shop found. Run /install/ to set up the database.', 503);
    }
    $shop = biq_numeric($shop, ['id', 'slot_minutes']);

    $plans = [];
    foreach (biq_all('SELECT * FROM plans ORDER BY sort_order') as $p) {
        $p = biq_numeric($p, ['setup_pence', 'monthly_pence', 'max_chairs', 'is_featured', 'sort_order']);
        $p['features'] = json_decode($p['features_json'], true) ?: [];
        $plans[] = $p;
    }

    // In demo mode the client can switch persona, so it needs the roster. Once
    // demo_mode is off we return only the signed-in customer's own record —
    // otherwise every customer can read everyone else's wallet balance.
    $config = biq_config();
    $customers = [];
    if (!empty($config['demo_mode'])) {
        foreach (biq_all(
            "SELECT c.id, c.name, c.avatar_emoji, c.email,
                    COALESCE(w.cash_pence,0) + COALESCE(w.bonus_pence,0) AS wallet_balance_pence,
                    (SELECT COUNT(*) FROM appointments a
                      WHERE a.customer_id = c.id AND a.status = 'completed') AS visits
               FROM customers c
               LEFT JOIN wallet_accounts w ON w.customer_id = c.id
              WHERE c.shop_id = ?
              ORDER BY visits DESC, c.name",
            [BIQ_SHOP_ID]
        ) as $c) {
            $customers[] = biq_numeric($c, ['id', 'wallet_balance_pence', 'visits']);
        }
    }

    $trialDaysLeft = null;
    if (!empty($shop['trial_ends_at'])) {
        $trialDaysLeft = max(0, biq_days_between(biq_now(), $shop['trial_ends_at']) + 1);
    }
    $shop['trial_days_left'] = $trialDaysLeft;

    biq_json([
        'shop'      => $shop,
        'plans'     => $plans,
        'customers' => $customers,
        'demo_mode' => (bool) ($config['demo_mode'] ?? false),
        'is_owner'  => biq_is_owner(),
        'owner_gate_enabled' => biq_owner_gate_enabled(),
    ]);
}
