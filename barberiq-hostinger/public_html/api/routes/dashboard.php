<?php
/**
 * E. OWNER DASHBOARD
 *
 * SQLite's date helpers do not exist in MySQL, so the range clauses use
 * DATE_SUB/CURDATE and the hour bucketing uses HOUR(). Behaviour is identical.
 */

declare(strict_types=1);

function biq_range_clause(string $range): string
{
    switch ($range) {
        case 'week':  return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)";
        case 'month': return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)";
        case 'year':  return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 364 DAY)";
        case 'today':
        default:      return "DATE(a.starts_at) = CURDATE()";
    }
}

function biq_prev_range_clause(string $range): string
{
    switch ($range) {
        case 'week':
            return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
                    AND a.starts_at < DATE_SUB(CURDATE(), INTERVAL 6 DAY)";
        case 'month':
            return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 59 DAY)
                    AND a.starts_at < DATE_SUB(CURDATE(), INTERVAL 29 DAY)";
        case 'year':
            return "a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 729 DAY)
                    AND a.starts_at < DATE_SUB(CURDATE(), INTERVAL 364 DAY)";
        case 'today':
        default:
            return "DATE(a.starts_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
    }
}

function biq_route_dashboard(): void
{
    $range = in_array($_GET['range'] ?? '', ['today', 'week', 'month', 'year'], true)
        ? $_GET['range'] : 'today';
    $where = biq_range_clause($range);

    $totals = biq_one(
        "SELECT COUNT(*) AS cuts,
                COALESCE(SUM(a.total_pence),0)   AS revenue_pence,
                COALESCE(SUM(a.service_pence),0) AS service_pence,
                COALESCE(SUM(a.addons_pence),0)  AS addons_pence,
                CAST(COALESCE(AVG(a.total_pence),0) AS SIGNED) AS avg_ticket_pence,
                COALESCE(SUM(CASE WHEN a.addons_pence > 0 THEN 1 ELSE 0 END),0) AS with_addons
           FROM appointments a
          WHERE a.shop_id = ? AND a.status = 'completed' AND $where",
        [BIQ_SHOP_ID]
    );
    $totals = biq_numeric($totals, array_keys($totals));

    $booked = (int) biq_val(
        "SELECT COUNT(*) FROM appointments a
          WHERE a.shop_id = ? AND a.status = 'booked' AND $where",
        [BIQ_SHOP_ID]
    );
    $noShows = (int) biq_val(
        "SELECT COUNT(*) FROM appointments a
          WHERE a.shop_id = ? AND a.status = 'no_show' AND $where",
        [BIQ_SHOP_ID]
    );

    $prevWhere = biq_prev_range_clause($range);
    $prev = biq_one(
        "SELECT COUNT(*) AS cuts, COALESCE(SUM(a.total_pence),0) AS revenue_pence
           FROM appointments a
          WHERE a.shop_id = ? AND a.status = 'completed' AND $prevWhere",
        [BIQ_SHOP_ID]
    );
    $prev = biq_numeric($prev, ['cuts', 'revenue_pence']);

    $wallet = biq_one('SELECT * FROM v_wallet_liability WHERE shop_id = ?', [BIQ_SHOP_ID]) ?: [
        'cash_liability_pence' => 0, 'bonus_liability_pence' => 0, 'total_liability_pence' => 0,
        'lifetime_topup_pence' => 0, 'lifetime_bonus_pence' => 0,
    ];
    $wallet = biq_numeric($wallet, array_keys($wallet));

    // Chart series
    if ($range === 'year') {
        $series = biq_all(
            "SELECT DATE_FORMAT(starts_at, '%x-W%v') AS bucket,
                    COALESCE(SUM(total_pence),0) AS revenue_pence, COUNT(*) AS cuts
               FROM appointments
              WHERE shop_id = ? AND status = 'completed'
                AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 364 DAY)
              GROUP BY bucket ORDER BY bucket",
            [BIQ_SHOP_ID]
        );
    } else {
        $days = $range === 'month' ? 30 : 14;
        $series = biq_all(
            "SELECT DATE(starts_at) AS bucket,
                    COALESCE(SUM(total_pence),0) AS revenue_pence, COUNT(*) AS cuts
               FROM appointments
              WHERE shop_id = ? AND status = 'completed'
                AND starts_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)
              GROUP BY bucket ORDER BY bucket",
            [BIQ_SHOP_ID]
        );
    }
    $series = array_map(fn($s) => biq_numeric($s, ['revenue_pence', 'cuts']), $series);

    $byHour = array_map(
        fn($h) => biq_numeric($h, ['hour', 'cuts', 'revenue_pence']),
        biq_all(
            "SELECT HOUR(starts_at) AS hour, COUNT(*) AS cuts,
                    COALESCE(SUM(total_pence),0) AS revenue_pence
               FROM appointments
              WHERE shop_id = ? AND status = 'completed'
                AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 89 DAY)
              GROUP BY HOUR(starts_at) ORDER BY hour",
            [BIQ_SHOP_ID]
        )
    );

    // Channel mix is deliberately NOT filtered by the selected range: it answers
    // a structural question, and on a quiet "today" the chart would collapse to
    // one segment and look broken.
    $sourceMix = array_map(
        fn($s) => biq_numeric($s, ['n', 'revenue_pence']),
        biq_all(
            "SELECT source, COUNT(*) AS n, COALESCE(SUM(total_pence),0) AS revenue_pence
               FROM appointments a
              WHERE a.shop_id = ? AND a.status = 'completed'
                AND a.starts_at >= DATE_SUB(CURDATE(), INTERVAL 89 DAY)
              GROUP BY source ORDER BY n DESC",
            [BIQ_SHOP_ID]
        )
    );

    $today = array_map(
        fn($t) => biq_numeric($t, ['id', 'total_pence']),
        biq_all(
            "SELECT a.id, a.starts_at, a.status, a.total_pence, a.paid_with,
                    c.name AS customer_name, c.avatar_emoji AS customer_emoji,
                    s.name AS service_name, s.icon AS service_icon,
                    b.nickname AS barber_name, b.avatar_emoji AS barber_emoji
               FROM appointments a
               JOIN customers c ON c.id = a.customer_id
               JOIN services  s ON s.id = a.service_id
               JOIN barbers   b ON b.id = a.barber_id
              WHERE a.shop_id = ? AND DATE(a.starts_at) = CURDATE()
              ORDER BY a.starts_at",
            [BIQ_SHOP_ID]
        )
    );

    // Client-level retention: of everyone who ever had a first visit, what share
    // came back. This is what owners mean by "retention", and it is deliberately
    // separate from the per-visit "return within 45 days" on the barber table —
    // they answer different questions and conflating them makes a dashboard lie.
    $ret = biq_one(
        "SELECT COUNT(*) AS ever,
                COALESCE(SUM(CASE WHEN visits >= 2 THEN 1 ELSE 0 END),0) AS returned
           FROM (SELECT customer_id, COUNT(*) AS visits
                   FROM appointments WHERE shop_id = ? AND status = 'completed'
                  GROUP BY customer_id) t",
        [BIQ_SHOP_ID]
    );
    $ever = (int) $ret['ever'];
    $returned = (int) $ret['returned'];

    $pct = fn($cur, $before) => $before > 0
        ? round(100 * ($cur - $before) / $before, 1) : null;

    biq_json([
        'range' => $range,
        'totals' => array_merge($totals, [
            'booked_ahead' => $booked,
            'no_shows' => $noShows,
            'addon_attach_pct' => $totals['cuts']
                ? round(100 * $totals['with_addons'] / $totals['cuts'], 1) : 0,
        ]),
        'retention' => [
            'ever_visited' => $ever,
            'returned_at_least_once' => $returned,
            'pct' => $ever ? round(100 * $returned / $ever, 1) : 0,
            'one_and_done' => $ever - $returned,
        ],
        'trend' => [
            'revenue_pct' => $pct($totals['revenue_pence'], $prev['revenue_pence']),
            'cuts_pct' => $pct($totals['cuts'], $prev['cuts']),
            'prev_revenue_pence' => $prev['revenue_pence'],
            'prev_cuts' => $prev['cuts'],
        ],
        'wallet' => $wallet,
        'series' => $series,
        'by_hour' => $byHour,
        'source_mix' => $sourceMix,
        'today' => $today,
    ]);
}

function biq_route_dash_barbers(): void
{
    $rows = array_map(
        fn($b) => biq_numeric(
            $b,
            ['barber_id', 'cuts', 'revenue_pence', 'addon_revenue_pence', 'avg_ticket_pence', 'commission_pence'],
            ['rating', 'addon_attach_pct']
        ),
        biq_all(
            'SELECT * FROM v_barber_performance WHERE shop_id = ? ORDER BY revenue_pence DESC',
            [BIQ_SHOP_ID]
        )
    );

    // Return-within-45-days, per visit.
    //
    // Must use EXISTS, not a LEFT JOIN. A join against "any later appointment"
    // emits one row per follow-up, so customers who return often are counted
    // many times and the ratio drifts towards 100%.
    $rebook = [];
    foreach (biq_all(
        "SELECT b.id AS barber_id,
                ROUND(100.0 * SUM(
                  CASE WHEN EXISTS (
                    SELECT 1 FROM appointments nxt
                     WHERE nxt.customer_id = a.customer_id
                       AND nxt.status = 'completed'
                       AND nxt.starts_at > a.starts_at
                       AND nxt.starts_at <= DATE_ADD(a.starts_at, INTERVAL 45 DAY)
                  ) THEN 1 ELSE 0 END
                ) / NULLIF(COUNT(a.id), 0), 1) AS rebook_pct
           FROM barbers b
           JOIN appointments a ON a.barber_id = b.id AND a.status = 'completed'
            AND a.starts_at < DATE_SUB(CURDATE(), INTERVAL 45 DAY)
          WHERE b.shop_id = ? GROUP BY b.id",
        [BIQ_SHOP_ID]
    ) as $r) {
        $rebook[(int) $r['barber_id']] = $r['rebook_pct'] === null ? null : (float) $r['rebook_pct'];
    }

    $recent = [];
    foreach (biq_all(
        "SELECT barber_id, COUNT(*) AS cuts, COALESCE(SUM(total_pence),0) AS revenue_pence
           FROM appointments
          WHERE shop_id = ? AND status = 'completed'
            AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
          GROUP BY barber_id",
        [BIQ_SHOP_ID]
    ) as $r) {
        $recent[(int) $r['barber_id']] = [
            'cuts' => (int) $r['cuts'],
            'revenue_pence' => (int) $r['revenue_pence'],
        ];
    }

    foreach ($rows as &$b) {
        $id = $b['barber_id'];
        $b['rebook_pct'] = $rebook[$id] ?? null;
        $b['recent_cuts'] = $recent[$id]['cuts'] ?? 0;
        $b['recent_revenue_pence'] = $recent[$id]['revenue_pence'] ?? 0;
    }
    unset($b);

    biq_json(['barbers' => $rows]);
}

function biq_route_dash_customers(): void
{
    $limit = max(1, min(100, biq_int($_GET['limit'] ?? null) ?? 20));
    $rows = biq_all(
        'SELECT * FROM v_customer_value WHERE shop_id = ? AND visits > 0
          ORDER BY lifetime_pence DESC LIMIT ' . $limit,
        [BIQ_SHOP_ID]
    );

    $out = [];
    foreach ($rows as $i => $c) {
        $c = biq_numeric($c, [
            'customer_id', 'visits', 'lifetime_pence', 'avg_ticket_pence',
            'days_since_visit', 'wallet_balance_pence', 'successful_referrals',
        ]);
        $cycle = biq_predict_cycle($c['customer_id']);
        $risk  = biq_churn_risk($c['customer_id'], $cycle);
        $c['rank'] = $i + 1;
        $c['cycle_days'] = $cycle['cycleDays'];
        $c['cycle_confidence'] = $cycle['confidence'];
        $c['risk_band'] = $risk['band'];
        $c['risk_label'] = $risk['label'];
        $c['risk_score'] = $risk['score'];
        $out[] = $c;
    }
    biq_json(['customers' => $out]);
}

/** The win-back list: overdue customers ranked by what they are worth. */
function biq_route_dash_winback(): void
{
    $rows = biq_all(
        'SELECT * FROM v_customer_value
          WHERE shop_id = ? AND visits >= 2 AND last_visit_at IS NOT NULL',
        [BIQ_SHOP_ID]
    );

    $scored = [];
    $totalOpportunity = 0;
    foreach ($rows as $c) {
        $c = biq_numeric($c, [
            'customer_id', 'visits', 'lifetime_pence', 'avg_ticket_pence',
            'days_since_visit', 'wallet_balance_pence', 'successful_referrals',
        ]);
        $cycle = biq_predict_cycle($c['customer_id']);
        $risk  = biq_churn_risk($c['customer_id'], $cycle);
        if (!in_array($risk['band'], ['overdue', 'at_risk', 'lost'], true)) {
            continue;
        }
        $c['cycle_days'] = $cycle['cycleDays'];
        $c['risk_band'] = $risk['band'];
        $c['risk_label'] = $risk['label'];
        $c['risk_score'] = $risk['score'];
        $c['risk_reason'] = $risk['reason'];
        $c['opportunity_pence'] = (int) round($c['avg_ticket_pence'] * $risk['score']);
        $totalOpportunity += $c['avg_ticket_pence'];
        $scored[] = $c;
    }

    usort($scored, fn($a, $b) =>
        ($b['risk_score'] * $b['avg_ticket_pence']) <=> ($a['risk_score'] * $a['avg_ticket_pence']));

    biq_json([
        'customers' => array_slice($scored, 0, 40),
        'total_opportunity_pence' => $totalOpportunity,
    ]);
}

function biq_route_dash_addons(): void
{
    $completed = max(1, (int) biq_val(
        "SELECT COUNT(*) FROM appointments WHERE shop_id = ? AND status = 'completed'",
        [BIQ_SHOP_ID]
    ));
    $rows = [];
    foreach (biq_all(
        'SELECT * FROM v_addon_performance WHERE shop_id = ? ORDER BY revenue_pence DESC',
        [BIQ_SHOP_ID]
    ) as $a) {
        $a = biq_numeric($a, ['addon_id', 'price_pence', 'times_sold', 'revenue_pence']);
        $a['attach_pct'] = round(100 * $a['times_sold'] / $completed, 1);
        $rows[] = $a;
    }
    biq_json(['addons' => $rows, 'completed_appointments' => $completed]);
}

function biq_route_dash_insights(): void
{
    biq_json(['insights' => biq_owner_insights()]);
}
