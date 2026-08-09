<?php
/**
 * A. WALLET
 *
 * Cash and bonus move independently and every movement is written to the
 * ledger, so the balance is always reconstructible from history rather than
 * being a number we hope is right.
 */

declare(strict_types=1);

function biq_route_wallet(int $customerId): void
{
    $customer = biq_require_customer($customerId);
    $w = biq_wallet_of((int) $customer['id']);

    $tiers = array_map(
        fn($t) => biq_numeric($t, ['id', 'pay_pence', 'bonus_pence', 'is_featured', 'active']),
        biq_all(
            'SELECT * FROM topup_tiers WHERE shop_id = ? AND active = 1 ORDER BY pay_pence',
            [BIQ_SHOP_ID]
        )
    );

    $tx = array_map(
        fn($t) => biq_numeric($t, [
            'id', 'amount_pence', 'cash_delta', 'bonus_delta', 'balance_after', 'appointment_id',
        ]),
        biq_all(
            'SELECT * FROM wallet_transactions WHERE wallet_id = ?
              ORDER BY created_at DESC, id DESC LIMIT 40',
            [(int) $w['id']]
        )
    );

    // The one number that drives top-up adoption: what using the wallet has
    // actually earned them, and what it is worth over a year at their rate.
    $cycle = biq_predict_cycle((int) $customer['id']);
    $avg = (int) biq_val(
        "SELECT COALESCE(AVG(total_pence),0) FROM appointments
          WHERE customer_id = ? AND status = 'completed'",
        [(int) $customer['id']]
    );

    $visitsPerYear = $cycle['cycleDays'] ? (int) round(365 / $cycle['cycleDays']) : 12;
    $bestRate = 0.10;
    $bestTier = null;
    foreach ($tiers as $t) {
        if ($t['pay_pence'] > 0 && $t['bonus_pence'] / $t['pay_pence'] >= $bestRate) {
            $bestRate = $t['bonus_pence'] / $t['pay_pence'];
            $bestTier = $t;
        }
    }
    $projected = (int) round($avg * $visitsPerYear * $bestRate);
    $saved = (int) $w['lifetime_bonus_pence'];

    biq_json([
        'wallet' => [
            'cash_pence'  => (int) $w['cash_pence'],
            'bonus_pence' => (int) $w['bonus_pence'],
            'balance_pence' => (int) $w['cash_pence'] + (int) $w['bonus_pence'],
            'lifetime_topup_pence' => (int) $w['lifetime_topup_pence'],
            'lifetime_bonus_pence' => $saved,
        ],
        'tiers' => $tiers,
        'transactions' => $tx,
        'insight' => [
            'saved_pence' => $saved,
            'avg_ticket_pence' => $avg,
            'visits_per_year' => $visitsPerYear,
            'projected_annual_bonus_pence' => $projected,
            'headline' => $saved > 0
                ? "You've earned " . biq_money($saved) . ' in bonus credit so far.'
                : "Top up £50 and you'll walk out with £55 to spend.",
            'subline' => $avg > 0
                ? sprintf(
                    'At your rate of about %d visits a year, topping up in %s blocks is worth '
                    . 'roughly %s a year in free credit.',
                    $visitsPerYear,
                    $bestTier ? biq_money($bestTier['pay_pence']) : '£100',
                    biq_money($projected)
                )
                : 'Bonus credit never expires and can be spent on any service or add-on.',
        ],
    ]);
}

function biq_route_topup(int $customerId): void
{
    $customer = biq_require_customer($customerId);
    $body = biq_body();
    $tierId = biq_int($body['tier_id'] ?? null);

    if ($tierId !== null) {
        $t = biq_one('SELECT * FROM topup_tiers WHERE id = ? AND shop_id = ?', [$tierId, BIQ_SHOP_ID]);
        if (!$t) {
            biq_fail('Unknown top-up tier.');
        }
        $pay = (int) $t['pay_pence'];
        $bonus = (int) $t['bonus_pence'];
        $label = (string) ($t['label'] ?? '');
    } else {
        $pay = biq_int($body['pay_pence'] ?? null);
        if ($pay === null || $pay < 500) {
            biq_fail('Minimum top-up is £5.00.');
        }
        if ($pay > 100000) {
            biq_fail('Maximum single top-up is £1,000.00.');
        }
        // Custom amounts earn the bonus rate of the highest tier they clear.
        $t = biq_one(
            'SELECT * FROM topup_tiers WHERE shop_id = ? AND active = 1 AND pay_pence <= ?
              ORDER BY pay_pence DESC LIMIT 1',
            [BIQ_SHOP_ID, $pay]
        );
        $rate = $t ? (int) $t['bonus_pence'] / (int) $t['pay_pence'] : 0.0;
        $bonus = (int) round($pay * $rate);
        $label = $t ? round($rate * 100) . '% bonus' : 'Top-up';
    }

    $w = biq_wallet_of((int) $customer['id']);

    $out = biq_transaction(function () use ($w, $pay, $bonus, $label) {
        $cash = (int) $w['cash_pence'] + $pay;
        $bns  = (int) $w['bonus_pence'] + $bonus;

        biq_exec(
            'UPDATE wallet_accounts
                SET cash_pence = ?, bonus_pence = ?,
                    lifetime_topup_pence = lifetime_topup_pence + ?,
                    lifetime_bonus_pence = lifetime_bonus_pence + ?
              WHERE id = ?',
            [$cash, $bns, $pay, $bonus, (int) $w['id']]
        );

        $sql = 'INSERT INTO wallet_transactions
                  (wallet_id, kind, amount_pence, bucket, cash_delta, bonus_delta,
                   balance_after, description)
                VALUES (?,?,?,?,?,?,?,?)';
        biq_insert($sql, [
            (int) $w['id'], 'topup', $pay, 'cash', $pay, 0, $cash + $bns,
            'Top-up ' . biq_money($pay),
        ]);
        if ($bonus > 0) {
            biq_insert($sql, [
                (int) $w['id'], 'bonus', $bonus, 'bonus', 0, $bonus, $cash + $bns,
                'Bonus credit ' . biq_money($bonus) . ($label !== '' ? " · $label" : ''),
            ]);
        }
        return ['cash' => $cash, 'bonus' => $bns];
    });

    biq_json([
        'ok' => true,
        'paid_pence' => $pay,
        'bonus_pence' => $bonus,
        'credited_pence' => $pay + $bonus,
        'balance_pence' => $out['cash'] + $out['bonus'],
        'message' => $bonus > 0
            ? 'Paid ' . biq_money($pay) . ' — ' . biq_money($pay + $bonus) . ' added to your wallet.'
            : biq_money($pay) . ' added to your wallet.',
    ], 201);
}
