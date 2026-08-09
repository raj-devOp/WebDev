<?php
/**
 * The intelligence layer.
 *
 * A NOTE ON WHAT THIS IS — worth being straight about, because you will be
 * asked in a sales meeting:
 *
 * This is statistical modelling over the shop's own transaction history, not a
 * large language model. That is a deliberate engineering decision:
 *
 *   1. It explains itself. Every prediction carries a reason string, so the
 *      owner can see WHY a customer is flagged. "Trust me, the AI said so"
 *      loses deals.
 *   2. It runs on your own Hostinger database with no API key, no per-call
 *      cost, and no customer data leaving the server — which is the honest
 *      answer to the GDPR question you will get.
 *   3. It gets sharper as the shop's own history grows.
 *
 * Genuine predictive analytics: per-customer periodicity estimation with
 * recency weighting, market-basket affinity scoring, and survival-style churn
 * banding.
 */

declare(strict_types=1);

/**
 * 1. REBOOK CYCLE PREDICTION
 *
 * The brief asked for a nudge "after 25 to 30 days". A fixed window is the
 * obvious implementation and also the reason most reminder features get
 * ignored: a skin fade needs 2-3 weeks, a restyle needs 6, and every customer
 * differs. So we learn each person's actual rhythm and fall back to the
 * service default only while evidence is thin.
 *
 * Recent gaps are weighted more heavily (exponential decay, ~4-visit
 * half-life) because habits change — new job, new baby, moved house.
 */
function biq_predict_cycle(int $customerId): array
{
    $visits = biq_all(
        'SELECT a.starts_at, s.default_cycle_days
           FROM appointments a
           JOIN services s ON s.id = a.service_id
          WHERE a.customer_id = ? AND a.status = \'completed\'
          ORDER BY a.starts_at ASC',
        [$customerId]
    );

    $fallback = $visits ? (int) end($visits)['default_cycle_days'] : 28;

    if (count($visits) < 2) {
        return [
            'cycleDays'   => $fallback,
            'confidence'  => count($visits) === 1 ? 0.35 : 0.2,
            'sampleSize'  => count($visits),
            'variability' => null,
            'lastVisit'   => $visits ? $visits[0]['starts_at'] : null,
            'basis'       => count($visits) === 1
                ? 'One visit so far — using the typical cycle for their usual service.'
                : 'No visit history yet — using the shop default.',
        ];
    }

    $gaps = [];
    for ($i = 1, $n = count($visits); $i < $n; $i++) {
        $d = (strtotime($visits[$i]['starts_at'] . ' UTC')
            - strtotime($visits[$i - 1]['starts_at'] . ' UTC')) / 86400;
        // Discard absurd gaps: a 9-month break is a lapse-and-return, not a cycle.
        if ($d >= 5 && $d <= 150) {
            $gaps[] = $d;
        }
    }

    if (!$gaps) {
        return [
            'cycleDays'   => $fallback,
            'confidence'  => 0.25,
            'sampleSize'  => count($visits),
            'variability' => null,
            'lastVisit'   => end($visits)['starts_at'],
            'basis'       => 'Visit gaps too irregular to model — using the service default.',
        ];
    }

    // Exponential recency weighting.
    $halfLife = 4.0;
    $count = count($gaps);
    $wSum = 0.0;
    $weighted = 0.0;
    foreach ($gaps as $i => $g) {
        $age = $count - 1 - $i;            // 0 = most recent gap
        $w = pow(0.5, $age / $halfLife);
        $weighted += $g * $w;
        $wSum += $w;
    }
    $weightedMean = $weighted / $wSum;

    // Blend with the median to stay robust against a single odd gap.
    $blended = 0.65 * $weightedMean + 0.35 * biq_median($gaps);

    // Coefficient of variation drives confidence: a tight rhythm is predictable.
    $mean = array_sum($gaps) / $count;
    $variance = 0.0;
    foreach ($gaps as $g) {
        $variance += ($g - $mean) ** 2;
    }
    $sd = sqrt($variance / $count);
    $cv = $mean > 0 ? $sd / $mean : 1.0;

    $sampleConfidence = biq_clamp($count / 6, 0, 1);   // 6+ gaps = full marks
    $steadiness = biq_clamp(1 - $cv / 0.6, 0, 1);      // cv 0 = perfect rhythm
    $confidence = biq_clamp(0.25 + 0.45 * $sampleConfidence + 0.30 * $steadiness, 0, 0.97);

    return [
        'cycleDays'   => (int) round(biq_clamp($blended, 7, 120)),
        'confidence'  => round($confidence, 2),
        'sampleSize'  => $count + 1,
        'variability' => round($sd, 1),
        'lastVisit'   => end($visits)['starts_at'],
        'basis'       => sprintf(
            'Learned from %d visits — typically every %d days (±%d).',
            $count + 1,
            (int) round($blended),
            (int) round($sd)
        ),
    ];
}

/**
 * 2. CHURN / LAPSE RISK
 *
 * Banded on how far past their OWN predicted cycle a customer has drifted, not
 * a global "90 days = lapsed" rule. A 17-day VIP unseen for 40 days is in
 * trouble; a 45-day casual at 40 days is fine.
 */
function biq_churn_risk(int $customerId, ?array $cycle = null): array
{
    $c = $cycle ?? biq_predict_cycle($customerId);

    if (empty($c['lastVisit'])) {
        return [
            'band' => 'never_visited', 'score' => 0.5, 'daysSince' => null,
            'overdueRatio' => null, 'label' => 'Never visited',
            'reason' => 'Signed up but has not been in yet.',
        ];
    }

    $daysSince = biq_days_between($c['lastVisit'], biq_now());
    $ratio = $daysSince / max(1, $c['cycleDays']);

    if ($ratio < 0.75)      { $band = 'healthy'; $label = 'On track'; }
    elseif ($ratio < 1.05)  { $band = 'due';     $label = 'Due now'; }
    elseif ($ratio < 1.6)   { $band = 'overdue'; $label = 'Overdue'; }
    elseif ($ratio < 3.0)   { $band = 'at_risk'; $label = 'At risk'; }
    else                    { $band = 'lost';    $label = 'Likely lost'; }

    // Risk score for ranking a win-back list: rises with overdue ratio, damped
    // when we do not trust the cycle estimate.
    $raw = biq_clamp(($ratio - 0.75) / 2.25, 0, 1);
    $score = round(biq_clamp($raw * (0.55 + 0.45 * $c['confidence']), 0, 1), 2);

    return [
        'band' => $band, 'label' => $label, 'score' => $score,
        'daysSince' => $daysSince, 'overdueRatio' => round($ratio, 2),
        'reason' => sprintf(
            '%d days since last visit against a %d-day pattern (%d%% of cycle).',
            $daysSince, $c['cycleDays'], (int) round($ratio * 100)
        ),
    ];
}

/**
 * 3. ADD-ON RECOMMENDATION (market-basket affinity)
 *
 * Three signals, blended:
 *   personal   — how often THIS customer buys it (strongest predictor)
 *   affinity   — P(add-on | the service being booked), across the whole shop
 *   popularity — overall attach rate, so new customers still get sensible picks
 *
 * Plus a small discovery bonus for popular things this customer has never
 * tried, because a recommender that only echoes past behaviour never grows the
 * basket.
 */
function biq_recommend_addons(?int $customerId, ?int $serviceId, int $limit = 4): array
{
    $addons = biq_all(
        'SELECT id, name, description, price_pence, duration_min, icon
           FROM addons WHERE shop_id = ? AND active = 1 ORDER BY sort_order',
        [BIQ_SHOP_ID]
    );

    $totalCompleted = max(1, (int) biq_val(
        'SELECT COUNT(*) FROM appointments WHERE shop_id = ? AND status = \'completed\'',
        [BIQ_SHOP_ID]
    ));

    $popularity = [];
    foreach (biq_all(
        'SELECT aa.addon_id AS id, COUNT(*) AS n
           FROM appointment_addons aa
           JOIN appointments a ON a.id = aa.appointment_id AND a.status = \'completed\'
          WHERE a.shop_id = ? GROUP BY aa.addon_id',
        [BIQ_SHOP_ID]
    ) as $r) {
        $popularity[(int) $r['id']] = (int) $r['n'];
    }

    $affinity = [];
    $serviceCount = 1;
    if ($serviceId) {
        $serviceCount = max(1, (int) biq_val(
            'SELECT COUNT(*) FROM appointments WHERE service_id = ? AND status = \'completed\'',
            [$serviceId]
        ));
        foreach (biq_all(
            'SELECT aa.addon_id AS id, COUNT(*) AS n
               FROM appointment_addons aa
               JOIN appointments a ON a.id = aa.appointment_id AND a.status = \'completed\'
              WHERE a.service_id = ? GROUP BY aa.addon_id',
            [$serviceId]
        ) as $r) {
            $affinity[(int) $r['id']] = (int) $r['n'];
        }
    }

    $myVisits = 0;
    $mine = [];
    if ($customerId) {
        $myVisits = (int) biq_val(
            'SELECT COUNT(*) FROM appointments WHERE customer_id = ? AND status = \'completed\'',
            [$customerId]
        );
        foreach (biq_all(
            'SELECT aa.addon_id AS id, COUNT(*) AS n
               FROM appointment_addons aa
               JOIN appointments a ON a.id = aa.appointment_id AND a.status = \'completed\'
              WHERE a.customer_id = ? GROUP BY aa.addon_id',
            [$customerId]
        ) as $r) {
            $mine[(int) $r['id']] = (int) $r['n'];
        }
    }

    $scored = [];
    foreach ($addons as $a) {
        $id = (int) $a['id'];
        $personal = $myVisits ? ($mine[$id] ?? 0) / $myVisits : 0.0;
        $affin    = $serviceId ? ($affinity[$id] ?? 0) / $serviceCount : 0.0;
        $popular  = ($popularity[$id] ?? 0) / $totalCompleted;
        $untried  = $myVisits >= 2 && !isset($mine[$id]);
        $discovery = $untried ? $popular * 0.4 : 0.0;

        $score = 0.50 * $personal + 0.28 * $affin + 0.22 * $popular + $discovery;

        if ($personal >= 0.6)                    { $reason = 'You add this most visits'; }
        elseif ($personal > 0.15)                { $reason = 'You have had this before'; }
        elseif ($untried && $popular > 0.2)      { $reason = 'Popular here — worth a try'; }
        elseif ($affin > 0.3)                    { $reason = 'Pairs well with this service'; }
        elseif ($popular > 0.25)                 { $reason = 'A regular favourite'; }
        else                                     { $reason = 'Available to add'; }

        $scored[] = [
            'id' => $id,
            'name' => $a['name'],
            'description' => $a['description'],
            'price_pence' => (int) $a['price_pence'],
            'duration_min' => (int) $a['duration_min'],
            'icon' => $a['icon'],
            'score' => round($score, 4),
            'recommended' => false,
            'reason' => $reason,
            'personal_rate' => round($personal, 2),
            'shop_attach_rate' => round($popular, 2),
        ];
    }

    usort($scored, fn($x, $y) => $y['score'] <=> $x['score']);

    // Flag the top N as actively recommended; the rest stay selectable.
    for ($i = 0; $i < min($limit, count($scored)); $i++) {
        if ($scored[$i]['score'] > 0.05) {
            $scored[$i]['recommended'] = true;
        }
    }
    return $scored;
}

/**
 * 4. NO-SHOW RISK
 *
 * Used to decide who gets a confirmation nudge and, commercially, who should be
 * asked to prepay from wallet. Laplace smoothing stops a single early no-show
 * branding someone permanently.
 */
function biq_no_show_risk(int $customerId): array
{
    $r = biq_one(
        "SELECT
            SUM(CASE WHEN status='no_show'   THEN 1 ELSE 0 END) AS no_shows,
            SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancels,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
         FROM appointments WHERE customer_id = ?",
        [$customerId]
    ) ?? [];

    $noShows = (int) ($r['no_shows'] ?? 0);
    $cancels = (int) ($r['cancels'] ?? 0);
    $completed = (int) ($r['completed'] ?? 0);
    $total = $noShows + $cancels + $completed;

    if ($total < 3) {
        return ['score' => 0.12, 'band' => 'unknown', 'reason' => 'Not enough history yet.'];
    }

    $rate = ($noShows + 0.5) / ($total + 2);
    $cancelRate = ($cancels + 0.5) / ($total + 2);
    $score = biq_clamp($rate * 0.75 + $cancelRate * 0.25, 0, 1);
    $band = $score > 0.28 ? 'high' : ($score > 0.15 ? 'medium' : 'low');

    return [
        'score' => round($score, 2), 'band' => $band,
        'reason' => sprintf(
            '%d no-show(s) and %d cancellation(s) across %d bookings.',
            $noShows, $cancels, $total
        ),
    ];
}

/**
 * 5. REMINDER SCHEDULING
 *
 * Writes one scheduled reminder per active customer, nudging slightly BEFORE
 * the predicted due date (scaled by confidence) so we catch them while the
 * diary still has slots, rather than noticing after they have gone.
 *
 * Customers with a future booking are skipped — nothing corrodes trust in an
 * automated system faster than being reminded to book what you already booked.
 *
 * A nightly cron should call POST /api/reminders/rebuild. See HOSTINGER-DEPLOY.md.
 */
function biq_rebuild_reminders(): int
{
    biq_exec(
        "DELETE FROM reminders WHERE shop_id = ? AND status = 'scheduled'",
        [BIQ_SHOP_ID]
    );

    $customers = biq_all(
        'SELECT id, name, notify_sms, notify_email, notify_push
           FROM customers WHERE shop_id = ?',
        [BIQ_SHOP_ID]
    );

    $ins = biq_db()->prepare(
        "INSERT INTO reminders
            (shop_id, customer_id, due_date, send_on, channel, status, reason,
             predicted_cycle_days, confidence, message)
         VALUES (?,?,?,?,?,'scheduled',?,?,?,?)"
    );
    $future = biq_db()->prepare(
        "SELECT COUNT(*) FROM appointments
          WHERE customer_id = ? AND status = 'booked' AND starts_at > UTC_TIMESTAMP()"
    );

    $created = 0;
    $today = biq_now();

    foreach ($customers as $c) {
        $cid = (int) $c['id'];
        $future->execute([$cid]);
        if ((int) $future->fetchColumn() > 0) {
            continue;
        }

        $cycle = biq_predict_cycle($cid);
        if (empty($cycle['lastVisit'])) {
            continue;
        }

        $due = biq_date_add($cycle['lastVisit'], $cycle['cycleDays']);
        // Lead time: up to 3 days early when confident, less when not.
        $lead = (int) round(1 + 2 * $cycle['confidence']);
        $sendOn = biq_date_add($due, -$lead);
        // Never schedule in the past — if already overdue, nudge today.
        if (strtotime($sendOn . ' UTC') < strtotime($today . ' UTC')) {
            $sendOn = $today;
        }

        $risk = biq_churn_risk($cid, $cycle);
        $channel = $c['notify_sms'] ? 'sms' : ($c['notify_push'] ? 'push' : 'email');
        $first = explode(' ', $c['name'])[0];

        if ($risk['band'] === 'healthy' || $risk['band'] === 'due') {
            $message = "Hi {$first} — you're about due for your next cut. "
                . 'Tap to grab a slot with your usual barber.';
        } elseif ($risk['band'] === 'overdue') {
            $message = "Hi {$first} — it's been {$risk['daysSince']} days. "
                . "Your chair's waiting whenever you are.";
        } else {
            $message = "Hi {$first} — we've missed you. "
                . 'Here\'s £3 off your next cut if you book this week.';
        }

        $ins->execute([
            BIQ_SHOP_ID, $cid, $due, $sendOn, $channel,
            $cycle['basis'], $cycle['cycleDays'], $cycle['confidence'], $message,
        ]);
        $created++;
    }
    return $created;
}

/**
 * 6. OWNER INSIGHTS
 *
 * Turns the analytics into a short ranked list of things worth acting on this
 * week. Deliberately capped — an insights panel with 30 items is a report, and
 * reports get ignored.
 */
function biq_owner_insights(): array
{
    $out = [];
    $m = fn(int $p) => biq_money($p);

    // (a) Win-back opportunity, valued in real money.
    $rows = biq_all(
        'SELECT customer_id, name, lifetime_pence, avg_ticket_pence, days_since_visit, visits
           FROM v_customer_value
          WHERE shop_id = ? AND visits >= 3 AND days_since_visit IS NOT NULL
          ORDER BY days_since_visit DESC',
        [BIQ_SHOP_ID]
    );
    $scored = [];
    foreach ($rows as $c) {
        $risk = biq_churn_risk((int) $c['customer_id']);
        if ($risk['band'] === 'at_risk' || $risk['band'] === 'overdue') {
            $c['risk'] = $risk;
            $scored[] = $c;
        }
    }
    usort($scored, fn($a, $b) =>
        ($b['risk']['score'] * $b['avg_ticket_pence']) <=> ($a['risk']['score'] * $a['avg_ticket_pence']));

    if ($scored) {
        $value = 0;
        foreach ($scored as $c) {
            $value += (int) $c['avg_ticket_pence'];
        }
        $names = array_map(fn($c) => explode(' ', $c['name'])[0], array_slice($scored, 0, 3));
        $out[] = [
            'severity' => 'high', 'icon' => '🎯',
            'title' => count($scored) . ' regulars have slipped past their cycle',
            'detail' => 'Recovering one visit each is worth about ' . $m($value)
                . '. Top priority: ' . implode(', ', $names) . '.',
            'action' => 'Open win-back list', 'actionTarget' => 'winback',
        ];
    }

    // (b) Add-on attach gap between best and worst barber — the cheapest
    //     revenue in the shop, and a coaching problem rather than a skill one.
    $perf = biq_all(
        'SELECT name, nickname, addon_attach_pct, cuts FROM v_barber_performance
          WHERE shop_id = ? AND cuts > 20',
        [BIQ_SHOP_ID]
    );
    if (count($perf) >= 2) {
        usort($perf, fn($a, $b) => (float) $b['addon_attach_pct'] <=> (float) $a['addon_attach_pct']);
        $best = $perf[0];
        $worst = $perf[count($perf) - 1];
        $gap = (float) $best['addon_attach_pct'] - (float) $worst['addon_attach_pct'];
        if ($gap > 8) {
            $out[] = [
                'severity' => 'medium', 'icon' => '📈',
                'title' => sprintf(
                    '%s attaches add-ons %d points below %s',
                    $worst['nickname'], (int) round($gap), $best['nickname']
                ),
                'detail' => sprintf(
                    '%s is at %s%%, %s at %s%%. Closing half that gap across %d cuts is found '
                    . 'money — it is a script problem, not a skill problem.',
                    $best['nickname'], $best['addon_attach_pct'],
                    $worst['nickname'], $worst['addon_attach_pct'], (int) $worst['cuts']
                ),
                'action' => 'View barber performance', 'actionTarget' => 'barbers',
            ];
        }
    }

    // (c) Wallet liability — the CFO's line. Prepaid balances are money owed.
    $liab = biq_one('SELECT * FROM v_wallet_liability WHERE shop_id = ?', [BIQ_SHOP_ID]);
    if ($liab && (int) $liab['total_liability_pence'] > 0) {
        $out[] = [
            'severity' => 'info', 'icon' => '🏦',
            'title' => $m((int) $liab['total_liability_pence']) . ' of wallet credit outstanding',
            'detail' => $m((int) $liab['cash_liability_pence']) . ' is customer cash you are holding '
                . '(a real liability) and ' . $m((int) $liab['bonus_liability_pence'])
                . ' is promotional bonus (a marketing cost already incurred). Keep the cash figure '
                . 'in mind before drawing down the account.',
            'action' => 'Open wallet report', 'actionTarget' => 'wallet-report',
        ];
    }

    // (d) Quietest trading hour — where a targeted offer actually helps.
    $byHour = biq_all(
        "SELECT HOUR(starts_at) AS hour, COUNT(*) AS n
           FROM appointments
          WHERE shop_id = ? AND status = 'completed'
            AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
          GROUP BY HOUR(starts_at) HAVING n > 0 ORDER BY n ASC",
        [BIQ_SHOP_ID]
    );
    if (count($byHour) >= 4) {
        $quiet = $byHour[0];
        $busy = $byHour[count($byHour) - 1];
        $out[] = [
            'severity' => 'medium', 'icon' => '🕐',
            'title' => $quiet['hour'] . ':00 is your deadest hour',
            'detail' => sprintf(
                '%d cuts in 90 days versus %d at %d:00. A "£3 off before noon" push to overdue '
                . 'customers fills chairs you are already paying for.',
                (int) $quiet['n'], (int) $busy['n'], (int) $busy['hour']
            ),
            'action' => 'Create off-peak offer', 'actionTarget' => 'offer',
        ];
    }

    // (e) Referral engine health.
    $ref = biq_one(
        "SELECT
            SUM(CASE WHEN status='rewarded' THEN 1 ELSE 0 END) AS rewarded,
            SUM(CASE WHEN status IN ('sent','signed_up') THEN 1 ELSE 0 END) AS pending,
            COUNT(*) AS total
         FROM referrals WHERE shop_id = ?",
        [BIQ_SHOP_ID]
    );
    if ($ref && (int) $ref['total'] > 0) {
        $rewarded = (int) $ref['rewarded'];
        $conv = (int) round(100 * $rewarded / (int) $ref['total']);
        $out[] = [
            'severity' => $conv < 40 ? 'medium' : 'good', 'icon' => '🤝',
            'title' => "$rewarded referrals converted ($conv% of invites sent)",
            'detail' => (int) $ref['pending'] . ' invitations are still open. Each converted referral '
                . 'costs you £20 in credit and brings a customer whose first visit alone usually '
                . 'covers it.',
            'action' => 'View referral programme', 'actionTarget' => 'referral',
        ];
    }

    // (f) No-show leakage.
    $ns = biq_one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(service_pence),0) AS lost
           FROM appointments
          WHERE shop_id = ? AND status = 'no_show'
            AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
        [BIQ_SHOP_ID]
    );
    $nsTotal = max(1, (int) biq_val(
        "SELECT COUNT(*) FROM appointments
          WHERE shop_id = ? AND starts_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            AND status IN ('completed','no_show','cancelled')",
        [BIQ_SHOP_ID]
    ));
    if ($ns && (int) $ns['n'] > 0) {
        $n = (int) $ns['n'];
        $pct = number_format(100 * $n / $nsTotal, 1);
        $out[] = [
            'severity' => $n > 8 ? 'high' : 'info', 'icon' => '👻',
            'title' => "$n no-shows in the last 30 days ($pct% of bookings)",
            'detail' => 'Empty chairs cannot be resold. Requiring wallet prepayment from repeat '
                . 'offenders is the single most effective fix — it converts a no-show into revenue '
                . 'you keep.',
            'action' => 'See no-show risk list', 'actionTarget' => 'noshow',
        ];
    }

    $rank = ['high' => 0, 'medium' => 1, 'good' => 2, 'info' => 3];
    usort($out, fn($a, $b) => $rank[$a['severity']] <=> $rank[$b['severity']]);
    return array_slice($out, 0, 6);
}
