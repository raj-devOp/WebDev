<?php
/** Services, barbers, add-on recommendations and free slots. */

declare(strict_types=1);

function biq_route_catalogue(): void
{
    $services = array_map(
        fn($s) => biq_numeric($s, ['id', 'price_pence', 'duration_min', 'default_cycle_days', 'sort_order']),
        biq_all('SELECT * FROM services WHERE shop_id = ? AND active = 1 ORDER BY sort_order', [BIQ_SHOP_ID])
    );
    $barbers = array_map(
        fn($b) => biq_numeric($b, ['id', 'commission_bps'], ['rating']),
        biq_all('SELECT * FROM barbers WHERE shop_id = ? AND active = 1 ORDER BY name', [BIQ_SHOP_ID])
    );
    biq_json(['services' => $services, 'barbers' => $barbers]);
}

function biq_route_recommend(): void
{
    $customerId = biq_int($_GET['customer_id'] ?? null);
    $serviceId  = biq_int($_GET['service_id'] ?? null);
    biq_json(['addons' => biq_recommend_addons($customerId, $serviceId)]);
}

/**
 * Free slots for a date, per barber.
 *
 * Returns every slot in the trading day with the list of barbers free at that
 * time, so the client can filter by barber without another round trip.
 */
function biq_route_slots(): void
{
    $date = substr((string) ($_GET['date'] ?? ''), 0, 10);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        biq_fail('date must be YYYY-MM-DD.');
    }
    // Reject an impossible date early rather than letting MySQL guess.
    [$y, $m, $d] = array_map('intval', explode('-', $date));
    if (!checkdate($m, $d, $y)) {
        biq_fail('That is not a real date.');
    }

    $shop = biq_one('SELECT * FROM shops WHERE id = ?', [BIQ_SHOP_ID]);
    $barbers = biq_all(
        'SELECT id, name, nickname, avatar_emoji FROM barbers WHERE shop_id = ? AND active = 1',
        [BIQ_SHOP_ID]
    );

    $busy = [];
    foreach (biq_all(
        "SELECT barber_id, DATE_FORMAT(starts_at, '%H:%i') AS hm
           FROM appointments
          WHERE shop_id = ? AND DATE(starts_at) = ? AND status IN ('booked','completed')",
        [BIQ_SHOP_ID, $date]
    ) as $r) {
        $busy[$r['barber_id'] . '|' . $r['hm']] = true;
    }

    $openMin  = (int) substr($shop['opens_at'], 0, 2) * 60 + (int) substr($shop['opens_at'], 3, 2);
    $closeMin = (int) substr($shop['closes_at'], 0, 2) * 60 + (int) substr($shop['closes_at'], 3, 2);
    $step = max(5, (int) $shop['slot_minutes']);
    $nowTs = time();

    $slots = [];
    for ($mins = $openMin; $mins < $closeMin; $mins += $step) {
        $time = sprintf('%02d:%02d', intdiv($mins, 60), $mins % 60);
        $free = [];
        foreach ($barbers as $b) {
            if (!isset($busy[$b['id'] . '|' . $time])) {
                $free[] = [
                    'id' => (int) $b['id'],
                    'name' => $b['nickname'] ?: $b['name'],
                    'emoji' => $b['avatar_emoji'],
                ];
            }
        }
        $slots[] = [
            'time' => $time,
            'in_past' => strtotime("$date $time:00 UTC") < $nowTs,
            'available_barbers' => $free,
        ];
    }

    biq_json([
        'date' => $date,
        'closed' => false, // the demo shop trades seven days; see seed notes
        'slots' => $slots,
    ]);
}
