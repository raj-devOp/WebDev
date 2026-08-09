<?php
/** B. REMINDERS */

declare(strict_types=1);

function biq_route_reminders(int $customerId): void
{
    $customer = biq_require_customer($customerId);
    $cid = (int) $customer['id'];

    $cycle = biq_predict_cycle($cid);
    $risk  = biq_churn_risk($cid, $cycle);

    $reminders = array_map(
        fn($r) => biq_numeric($r, ['id', 'predicted_cycle_days', 'resulting_appointment_id'], ['confidence']),
        biq_all(
            'SELECT r.*,
                    (SELECT COUNT(*) FROM appointments a
                      WHERE a.customer_id = r.customer_id AND a.status = \'booked\'
                        AND a.starts_at > UTC_TIMESTAMP()) AS has_upcoming
               FROM reminders r WHERE r.customer_id = ? ORDER BY r.send_on ASC',
            [$cid]
        )
    );

    $upcoming = array_map(
        fn($a) => biq_numeric($a, ['id', 'duration_min', 'total_pence', 'service_pence', 'addons_pence']),
        biq_all(
            "SELECT a.*, s.name AS service_name, s.icon AS service_icon,
                    b.name AS barber_name, b.avatar_emoji AS barber_emoji
               FROM appointments a
               JOIN services s ON s.id = a.service_id
               JOIN barbers  b ON b.id = a.barber_id
              WHERE a.customer_id = ? AND a.status = 'booked' AND a.starts_at > UTC_TIMESTAMP()
              ORDER BY a.starts_at ASC",
            [$cid]
        )
    );

    $history = array_map(
        fn($h) => biq_numeric($h, ['total_pence']),
        biq_all(
            "SELECT a.starts_at, a.total_pence, s.name AS service_name, s.icon AS service_icon,
                    b.nickname AS barber_name
               FROM appointments a
               JOIN services s ON s.id = a.service_id
               JOIN barbers  b ON b.id = a.barber_id
              WHERE a.customer_id = ? AND a.status = 'completed'
              ORDER BY a.starts_at DESC LIMIT 8",
            [$cid]
        )
    );

    biq_json([
        'cycle' => $cycle,
        'risk' => $risk,
        'reminders' => $reminders,
        'upcoming' => $upcoming,
        'history' => $history,
        'preferences' => [
            'sms'   => (bool) $customer['notify_sms'],
            'email' => (bool) $customer['notify_email'],
            'push'  => (bool) $customer['notify_push'],
        ],
    ]);
}

function biq_route_reminder_action(int $id): void
{
    $action = biq_str(biq_body()['action'] ?? '', 20);
    $r = biq_one('SELECT * FROM reminders WHERE id = ?', [$id]);
    if (!$r) {
        biq_fail('Reminder not found.', 404);
    }

    if ($action === 'snooze') {
        $days = biq_int(biq_body()['days'] ?? null) ?? 7;
        $days = max(1, min(30, $days));
        $next = biq_date_add(biq_now(), $days);
        biq_exec("UPDATE reminders SET status = 'snoozed', send_on = ? WHERE id = ?", [$next, $id]);
        biq_json(['ok' => true, 'status' => 'snoozed', 'send_on' => $next]);
    }
    if ($action === 'dismiss') {
        biq_exec("UPDATE reminders SET status = 'dismissed' WHERE id = ?", [$id]);
        biq_json(['ok' => true, 'status' => 'dismissed']);
    }
    if ($action === 'send') {
        // In production this hands off to an SMS/email provider. Here we mark it
        // sent so the owner can see the pipeline working end to end.
        biq_exec("UPDATE reminders SET status = 'sent', sent_at = UTC_TIMESTAMP() WHERE id = ?", [$id]);
        biq_json(['ok' => true, 'status' => 'sent']);
    }
    biq_fail('action must be one of: snooze, dismiss, send.');
}

function biq_route_reminder_prefs(int $customerId): void
{
    $customer = biq_require_customer($customerId);
    $b = biq_body();
    biq_exec(
        'UPDATE customers SET notify_sms = ?, notify_email = ?, notify_push = ? WHERE id = ?',
        [
            !empty($b['sms']) ? 1 : 0,
            !empty($b['email']) ? 1 : 0,
            !empty($b['push']) ? 1 : 0,
            (int) $customer['id'],
        ]
    );
    biq_json(['ok' => true]);
}

/**
 * Rebuild the whole reminder schedule. This is what a nightly cron calls —
 * see HOSTINGER-DEPLOY.md for the hPanel Cron Jobs entry.
 */
function biq_route_rebuild_reminders(): void
{
    biq_json(['ok' => true, 'scheduled' => biq_rebuild_reminders()]);
}
