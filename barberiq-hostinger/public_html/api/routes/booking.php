<?php
/**
 * C. BOOKING + ADD-ONS
 *
 * Booking and the wallet debit that pays for it are one transaction. If the
 * slot turns out to be taken, the debit must not survive — hence the unique
 * index on the generated `active_slot` column doing the final arbitration
 * rather than a check-then-insert race.
 */

declare(strict_types=1);

function biq_route_create_booking(): void
{
    $b = biq_body();
    $customerId = biq_int($b['customer_id'] ?? null);
    $barberId   = biq_int($b['barber_id'] ?? null);
    $serviceId  = biq_int($b['service_id'] ?? null);
    $startsAt   = biq_str($b['starts_at'] ?? '', 25);
    $addonIds   = is_array($b['addon_ids'] ?? null)
        ? array_values(array_filter(array_map('biq_int', $b['addon_ids']), fn($v) => $v !== null))
        : [];
    $payWithWallet = !empty($b['pay_with_wallet']);
    // Read once into a local before testing it. Writing
    // `in_array($b['source'] ?? 'app', ...) ? $b['source'] : 'app'` leaves the
    // second read unguarded, and on a request without `source` PHP emits an
    // "Undefined array key" warning that is printed BEFORE the JSON body —
    // which makes the whole response unparseable to the client.
    $requestedSource = $b['source'] ?? 'app';
    $source = in_array($requestedSource, ['app', 'reminder', 'walk_in', 'phone', 'referral'], true)
        ? $requestedSource : 'app';

    $customer = biq_one('SELECT * FROM customers WHERE id = ? AND shop_id = ?', [$customerId, BIQ_SHOP_ID]);
    if (!$customer) {
        biq_fail('Customer not found.', 404);
    }
    $service = biq_one('SELECT * FROM services WHERE id = ? AND shop_id = ?', [$serviceId, BIQ_SHOP_ID]);
    if (!$service) {
        biq_fail('Service not found.', 404);
    }
    $barber = biq_one('SELECT * FROM barbers WHERE id = ? AND shop_id = ?', [$barberId, BIQ_SHOP_ID]);
    if (!$barber) {
        biq_fail('Barber not found.', 404);
    }

    if (!preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/', $startsAt, $mm)) {
        biq_fail('starts_at must look like YYYY-MM-DD HH:MM.');
    }
    $normalised = $mm[1] . ' ' . $mm[2] . ':00';
    if (strtotime($normalised . ' UTC') < time() - 60) {
        biq_fail('That slot is in the past.');
    }

    $barberName = $barber['nickname'] ?: $barber['name'];
    $clash = biq_val(
        "SELECT id FROM appointments
          WHERE barber_id = ? AND starts_at = ? AND status IN ('booked','completed')",
        [$barberId, $normalised]
    );
    if ($clash) {
        biq_fail("$barberName is already booked at that time.", 409);
    }

    $chosen = [];
    if ($addonIds) {
        $ph = implode(',', array_fill(0, count($addonIds), '?'));
        $chosen = biq_all(
            "SELECT * FROM addons WHERE shop_id = ? AND active = 1 AND id IN ($ph)",
            array_merge([BIQ_SHOP_ID], $addonIds)
        );
    }

    $addonsPence = 0;
    $addonMinutes = 0;
    foreach ($chosen as $a) {
        $addonsPence += (int) $a['price_pence'];
        $addonMinutes += (int) $a['duration_min'];
    }
    $servicePence = (int) $service['price_pence'];
    $duration = (int) $service['duration_min'] + $addonMinutes;
    $total = $servicePence + $addonsPence;

    $w = biq_wallet_of((int) $customer['id']);
    $available = (int) $w['cash_pence'] + (int) $w['bonus_pence'];
    if ($payWithWallet && $available < $total) {
        biq_fail(
            'Wallet balance is ' . biq_money($available) . ' — ' . biq_money($total - $available)
            . ' short. Top up or pay in the chair.'
        );
    }

    try {
        $apptId = biq_transaction(function () use (
            $customer, $barberId, $serviceId, $normalised, $duration, $servicePence,
            $addonsPence, $total, $payWithWallet, $source, $chosen, $w, $service
        ) {
            $id = biq_insert(
                "INSERT INTO appointments
                    (shop_id, customer_id, barber_id, service_id, starts_at, duration_min,
                     status, service_pence, addons_pence, discount_pence, total_pence,
                     paid_with, source)
                 VALUES (?,?,?,?,?,?,'booked',?,?,0,?,?,?)",
                [
                    BIQ_SHOP_ID, (int) $customer['id'], $barberId, $serviceId, $normalised,
                    $duration, $servicePence, $addonsPence, $total,
                    $payWithWallet ? 'wallet' : 'unpaid', $source,
                ]
            );

            foreach ($chosen as $a) {
                biq_insert(
                    'INSERT INTO appointment_addons (appointment_id, addon_id, price_pence) VALUES (?,?,?)',
                    [$id, (int) $a['id'], (int) $a['price_pence']]
                );
            }

            if ($payWithWallet && $total > 0) {
                // Bonus is consumed before cash: it retires promotional
                // liability first and keeps refundable cash on the account.
                $fromBonus = min((int) $w['bonus_pence'], $total);
                $fromCash = $total - $fromBonus;
                $newBonus = (int) $w['bonus_pence'] - $fromBonus;
                $newCash = (int) $w['cash_pence'] - $fromCash;

                biq_exec(
                    'UPDATE wallet_accounts SET cash_pence = ?, bonus_pence = ? WHERE id = ?',
                    [$newCash, $newBonus, (int) $w['id']]
                );
                biq_insert(
                    "INSERT INTO wallet_transactions
                        (wallet_id, kind, amount_pence, bucket, cash_delta, bonus_delta,
                         balance_after, appointment_id, description)
                     VALUES (?,'spend',?,'split',?,?,?,?,?)",
                    [
                        (int) $w['id'], -$total, -$fromCash, -$fromBonus,
                        $newCash + $newBonus, $id,
                        $service['name'] . (count($chosen) ? ' + ' . count($chosen) . ' add-on(s)' : ''),
                    ]
                );
            }

            // Any scheduled reminder for this customer has done its job.
            biq_exec(
                "UPDATE reminders SET status = 'booked', resulting_appointment_id = ?
                  WHERE customer_id = ? AND status IN ('scheduled','sent','snoozed')",
                [$id, (int) $customer['id']]
            );

            return $id;
        });
    } catch (PDOException $e) {
        // 23000 = integrity constraint. The unique index on active_slot is the
        // real guard against two people booking the same chair at once.
        if ($e->getCode() === '23000') {
            biq_fail("$barberName was just booked at that time. Pick another slot.", 409);
        }
        throw $e;
    }

    $appt = biq_one(
        'SELECT a.*, s.name AS service_name, s.icon AS service_icon,
                b.name AS barber_name, b.nickname AS barber_nickname,
                b.avatar_emoji AS barber_emoji
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           JOIN barbers  b ON b.id = a.barber_id
          WHERE a.id = ?',
        [$apptId]
    );
    $appt = biq_numeric($appt, [
        'id', 'shop_id', 'customer_id', 'barber_id', 'service_id', 'duration_min',
        'service_pence', 'addons_pence', 'discount_pence', 'total_pence',
    ]);
    $appt['addons'] = array_map(
        fn($a) => biq_numeric($a, ['id', 'price_pence', 'duration_min']),
        $chosen
    );

    $after = biq_wallet_of((int) $customer['id']);
    biq_json([
        'ok' => true,
        'appointment' => $appt,
        'charged_to_wallet' => $payWithWallet ? $total : 0,
        'wallet_balance_pence' => (int) $after['cash_pence'] + (int) $after['bonus_pence'],
    ], 201);
}

function biq_route_list_bookings(int $customerId): void
{
    $customer = biq_require_customer($customerId);
    $rows = biq_all(
        'SELECT a.*, s.name AS service_name, s.icon AS service_icon,
                b.nickname AS barber_name, b.avatar_emoji AS barber_emoji
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           JOIN barbers  b ON b.id = a.barber_id
          WHERE a.customer_id = ?
          ORDER BY a.starts_at DESC LIMIT 30',
        [(int) $customer['id']]
    );

    $out = [];
    foreach ($rows as $r) {
        $r = biq_numeric($r, [
            'id', 'duration_min', 'service_pence', 'addons_pence', 'discount_pence', 'total_pence',
        ]);
        $r['addons'] = array_map(
            fn($a) => biq_numeric($a, ['price_pence']),
            biq_all(
                'SELECT ad.name, ad.icon, aa.price_pence
                   FROM appointment_addons aa
                   JOIN addons ad ON ad.id = aa.addon_id
                  WHERE aa.appointment_id = ?',
                [$r['id']]
            )
        );
        $out[] = $r;
    }
    biq_json(['appointments' => $out]);
}

function biq_route_cancel_booking(int $id): void
{
    $appt = biq_one("SELECT * FROM appointments WHERE id = ? AND status = 'booked'", [$id]);
    if (!$appt) {
        biq_fail('No open booking with that id.', 404);
    }

    biq_transaction(function () use ($appt, $id) {
        biq_exec("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [$id]);

        // Refund to the wallet if prepaid, reversing the exact split taken.
        if ($appt['paid_with'] === 'wallet' && (int) $appt['total_pence'] > 0) {
            $spend = biq_one(
                "SELECT * FROM wallet_transactions
                  WHERE appointment_id = ? AND kind = 'spend' ORDER BY id DESC LIMIT 1",
                [$id]
            );
            $w = biq_wallet_of((int) $appt['customer_id']);
            $cashBack  = $spend ? -(int) $spend['cash_delta'] : (int) $appt['total_pence'];
            $bonusBack = $spend ? -(int) $spend['bonus_delta'] : 0;
            $newCash  = (int) $w['cash_pence'] + $cashBack;
            $newBonus = (int) $w['bonus_pence'] + $bonusBack;

            biq_exec(
                'UPDATE wallet_accounts SET cash_pence = ?, bonus_pence = ? WHERE id = ?',
                [$newCash, $newBonus, (int) $w['id']]
            );
            biq_insert(
                "INSERT INTO wallet_transactions
                    (wallet_id, kind, amount_pence, bucket, cash_delta, bonus_delta,
                     balance_after, appointment_id, description)
                 VALUES (?,'refund',?,'split',?,?,?,?,'Cancelled booking refunded')",
                [
                    (int) $w['id'], (int) $appt['total_pence'], $cashBack, $bonusBack,
                    $newCash + $newBonus, $id,
                ]
            );
        }
    });

    biq_json(['ok' => true]);
}

/**
 * Mark an appointment done.
 *
 * This is the trigger that qualifies a referral — deliberately NOT on booking,
 * so fake sign-ups cannot mint credit.
 */
function biq_route_complete_booking(int $id): void
{
    $appt = biq_one("SELECT * FROM appointments WHERE id = ? AND status = 'booked'", [$id]);
    if (!$appt) {
        biq_fail('No open booking with that id.', 404);
    }

    $rewarded = biq_transaction(function () use ($appt, $id) {
        biq_exec("UPDATE appointments SET status = 'completed' WHERE id = ?", [$id]);
        $paid = [];

        $pending = biq_one(
            "SELECT * FROM referrals
              WHERE referred_id = ? AND status IN ('signed_up','sent') AND shop_id = ?",
            [(int) $appt['customer_id'], BIQ_SHOP_ID]
        );
        if ($pending) {
            $completedCount = (int) biq_val(
                "SELECT COUNT(*) FROM appointments WHERE customer_id = ? AND status = 'completed'",
                [(int) $appt['customer_id']]
            );
            // Only the FIRST completed visit qualifies.
            if ($completedCount === 1) {
                biq_exec(
                    "UPDATE referrals SET status = 'rewarded',
                            qualifying_appointment_id = ?, rewarded_at = UTC_TIMESTAMP()
                      WHERE id = ?",
                    [$id, (int) $pending['id']]
                );
                $reward = (int) $pending['reward_pence'];
                foreach ([(int) $pending['referrer_id'], (int) $pending['referred_id']] as $side) {
                    $w = biq_wallet_of($side);
                    $nb = (int) $w['bonus_pence'] + $reward;
                    biq_exec('UPDATE wallet_accounts SET bonus_pence = ? WHERE id = ?', [$nb, (int) $w['id']]);
                    biq_insert(
                        "INSERT INTO wallet_transactions
                            (wallet_id, kind, amount_pence, bucket, cash_delta, bonus_delta,
                             balance_after, description)
                         VALUES (?,'referral_credit',?,'bonus',0,?,?,?)",
                        [
                            (int) $w['id'], $reward, $reward,
                            (int) $w['cash_pence'] + $nb,
                            'Referral reward ' . biq_money($reward),
                        ]
                    );
                    $paid[] = $side;
                }
            }
        }
        return $paid;
    });

    biq_json(['ok' => true, 'referral_rewarded_customer_ids' => $rewarded]);
}
