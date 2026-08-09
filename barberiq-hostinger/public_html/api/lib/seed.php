<?php
/**
 * Demo data generator.
 *
 * Generates ~12 months of trading history for a 5-chair shop, with dates
 * relative to *today*. That matters: a static SQL dump with baked-in dates
 * shows "today's earnings: £0.00" the moment it goes stale, which makes the
 * product look broken in exactly the meeting you were saving it for.
 *
 * The numbers come from per-customer behavioural profiles rather than uniform
 * random noise, because the intelligence engine is only convincing if the
 * underlying data has real structure to find:
 *
 *   - loyal customers return on a tight cycle (low variance)
 *   - drifters widen the gap between visits
 *   - a long tail came once or twice and never returned
 *
 * That structure is what makes the churn scores, cycle predictions and the
 * barber coaching insight land as insight rather than decoration.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so every install produces identical figures.
// A sales demo that shows different numbers each time cannot be rehearsed.
// ---------------------------------------------------------------------------
final class BiqRng
{
    private int $a;

    public function __construct(int $seed)
    {
        $this->a = $seed & 0xFFFFFFFF;
    }

    public function next(): float
    {
        $this->a = ($this->a + 0x6D2B79F5) & 0xFFFFFFFF;
        $t = $this->a;
        $t = (($t ^ ($t >> 15)) * ($t | 1)) & 0xFFFFFFFF;
        $t ^= ($t + ((($t ^ ($t >> 7)) * ($t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF;
        $t &= 0xFFFFFFFF;
        return (($t ^ ($t >> 14)) & 0xFFFFFFFF) / 4294967296;
    }

    public function int(int $lo, int $hi): int
    {
        return $lo + (int) floor($this->next() * ($hi - $lo + 1));
    }

    public function pick(array $arr)
    {
        return $arr[(int) floor($this->next() * count($arr))];
    }

    /** Box-Muller: a believable bell curve of visit gaps. */
    public function gauss(float $mean, float $sd): float
    {
        $u = max($this->next(), 1e-9);
        $v = max($this->next(), 1e-9);
        return $mean + $sd * sqrt(-2 * log($u)) * cos(2 * M_PI * $v);
    }
}

function biq_seed_all(): array
{
    $db = biq_db();
    $rng = new BiqRng(20260809);

    // ---------------------------------------------------------------- wipe
    // Children before parents. FK checks off so order cannot bite us.
    $db->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach ([
        'wallet_transactions', 'wallet_accounts', 'appointment_addons', 'reminders',
        'referrals', 'appointments', 'addons', 'services', 'topup_tiers',
        'customers', 'barbers', 'shops', 'plans',
    ] as $t) {
        $db->exec("TRUNCATE TABLE `$t`");
    }
    $db->exec('SET FOREIGN_KEY_CHECKS = 1');

    // Everything below runs in one transaction. With InnoDB in autocommit mode
    // each of the ~15,000 inserts is its own durable write, which turns a
    // 5-second job into a 60-second one — and shared hosting usually kills a
    // PHP request at 30. TRUNCATE above must stay outside: it is DDL and
    // implicitly commits.
    $db->beginTransaction();

    $now = time();
    $iso = fn(int $ts) => gmdate('Y-m-d H:i:s', $ts);
    $addDays = fn(int $ts, float $n) => $ts + (int) round($n * 86400);

    // --------------------------------------------------------------- plans
    // Pricing derived from 2026 market research — see COMMERCIAL-PACK.md.
    $insPlan = $db->prepare(
        'INSERT INTO plans (code,name,setup_pence,monthly_pence,max_chairs,blurb,features_json,is_featured,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)'
    );
    $insPlan->execute(['starter', 'Starter', 49900, 5900, 2,
        'Solo barbers and two-chair shops finding their feet.',
        json_encode([
            'Online booking + add-ons', 'Prepaid wallet with bonus tiers',
            'Automatic rebook reminders', 'Referral programme',
            'Owner dashboard', 'Up to 2 chairs', 'Email support',
        ]), 0, 1]);
    $insPlan->execute(['professional', 'Professional', 149900, 11900, 6,
        'The workhorse plan for a busy high-street shop.',
        json_encode([
            'Everything in Starter', 'AI rebook prediction (per-customer cycles)',
            'Add-on recommendation engine', 'Churn-risk & win-back lists',
            'Barber performance & commission reports', 'Top-20 customer intelligence',
            'Up to 6 chairs', 'SMS reminders included (1,000/mo)',
            'Priority support + quarterly review',
        ]), 1, 2]);
    $insPlan->execute(['multisite', 'Multi-Site', 349900, 24900, null,
        'Groups running more than one location.',
        json_encode([
            'Everything in Professional', 'Unlimited chairs',
            'Multi-location roll-up reporting', 'Cross-site wallet (spend anywhere)',
            'Staff league tables across sites', 'White-label branding + own domain',
            'API access & data export', 'Named account manager',
        ]), 0, 3]);

    // ---------------------------------------------------------------- shop
    $shopId = (int) biq_insert(
        'INSERT INTO shops (name,slug,address_line1,city,postcode,phone,email,plan_code,
                            trial_ends_at,subscription_state,opens_at,closes_at,slot_minutes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
            'Sharp & Co. Barbers', 'sharp-and-co', '42 Deansgate', 'Manchester', 'M3 2AY',
            '0161 496 0142', 'hello@sharpandco.example', 'professional',
            $iso($addDays($now, 30)), 'trialing', '09:00:00', '19:00:00', 30,
        ]
    );

    // ------------------------------------------------------------- barbers
    // `demand` weights how often a barber is picked (the busy chair versus the
    // quiet one) and `upsell` scales how often they attach an add-on. These two
    // numbers are what give the league table a story — assign work uniformly
    // and every barber lands within a couple of percent, the ranking becomes
    // noise, and the "coach your weakest upseller" insight finds nothing.
    $barberSpec = [
        ['Aisha Rahman', 'Aisha', '✂️', 'Fades & skin tapers',         4200, 4.9, 1.45, 1.55],
        ['Tony Marino',  'Tony',  '💈', 'Scissor work & classic cuts', 4500, 4.8, 1.20, 1.20],
        ['Kwame Osei',   'Kwame', '🧑‍🎤', 'Textured & afro hair',       4000, 4.8, 1.05, 0.95],
        ['Declan Byrne', 'Dec',   '🪒', 'Beard sculpting & hot towel', 4000, 4.6, 0.80, 0.70],
        ['Sofia Toma',   'Sofia', '💫', 'Kids & family cuts',          3800, 4.5, 0.55, 0.42],
    ];
    $barbers = [];
    foreach ($barberSpec as $b) {
        $id = (int) biq_insert(
            'INSERT INTO barbers (shop_id,name,nickname,avatar_emoji,specialty,commission_bps,rating,hired_at)
             VALUES (?,?,?,?,?,?,?,?)',
            [$shopId, $b[0], $b[1], $b[2], $b[3], $b[4], $b[5], $iso($addDays($now, -$rng->int(400, 1500)))]
        );
        $barbers[] = ['id' => $id, 'demand' => $b[6], 'upsell' => $b[7]];
    }
    $demandTotal = array_sum(array_column($barbers, 'demand'));
    $pickBarber = function () use ($barbers, $demandTotal, $rng) {
        $r = $rng->next() * $demandTotal;
        foreach ($barbers as $b) {
            $r -= $b['demand'];
            if ($r <= 0) return $b;
        }
        return $barbers[count($barbers) - 1];
    };

    // ------------------------------------------------- services and add-ons
    $serviceSpec = [
        ['Skin Fade',   'Sharp fade blended to the skin, finished with a line-up.', 2200, 40, '💈', 21, 1],
        ['Classic Cut', 'Scissor cut, tapered and styled to your preference.',      1800, 30, '✂️', 28, 2],
        ['Buzz Cut',    'Single-length clipper cut, quick and clean.',              1200, 20, '⚡', 21, 3],
        ['Cut & Beard', 'Full haircut plus beard shape-up in one sitting.',         2800, 50, '🧔', 25, 4],
        ['Kids Cut',    'Under-12s, patient and unhurried.',                        1400, 25, '🧒', 35, 5],
        ['Restyle',     'Consultation plus a full change of direction.',            3200, 60, '🌟', 42, 6],
    ];
    $services = [];
    foreach ($serviceSpec as $s) {
        $id = (int) biq_insert(
            'INSERT INTO services (shop_id,name,description,price_pence,duration_min,icon,default_cycle_days,sort_order)
             VALUES (?,?,?,?,?,?,?,?)',
            [$shopId, $s[0], $s[1], $s[2], $s[3], $s[4], $s[5], $s[6]]
        );
        $services[] = ['id' => $id, 'name' => $s[0], 'price' => $s[2], 'duration' => $s[3]];
    }

    // The last column is the shop-wide attach rate. Scaled so a typical
    // appointment carries ~0.8 add-ons and just over half of visits have at
    // least one. Do not inflate these — the demo becomes indefensible the
    // moment an owner compares it against their own till roll.
    $addonSpec = [
        ['Beard Trim',      'Shape, line up and condition the beard.',            800, 15, '🧔', 1, 0.110],
        ['Hot Towel Shave', 'Traditional straight-razor finish with hot towels.', 1500, 25, '🪒', 2, 0.038],
        ['Head Massage',    'Five minutes of pressure-point relief.',             600, 10, '💆', 3, 0.090],
        ['Hair Wash',       'Shampoo, condition and blow dry.',                   500, 10, '🚿', 4, 0.100],
        ['Eyebrow Tidy',    'Neaten and shape the brow line.',                    400,  8, '👁️', 5, 0.045],
        ['Grey Blending',   'Softens grey without a harsh block colour.',        1800, 30, '🎨', 6, 0.022],
        ['Nose & Ear Wax',  'Quick, thorough and less painful than you fear.',    700, 10, '👂', 7, 0.029],
        ['Styling & Wax',   'Product applied and styled to hold all day.',        350,  5, '💧', 8, 0.070],
        ['Line-Up Only',    'Sharpen the hairline between full cuts.',            600, 10, '📐', 9, 0.035],
        ['Face Mask',       'Charcoal mask to clear and calm the skin.',           900, 15, '🧖', 10, 0.019],
    ];
    $addons = [];
    foreach ($addonSpec as $a) {
        $id = (int) biq_insert(
            'INSERT INTO addons (shop_id,name,description,price_pence,duration_min,icon,sort_order)
             VALUES (?,?,?,?,?,?,?)',
            [$shopId, $a[0], $a[1], $a[2], $a[3], $a[4], $a[5]]
        );
        $addons[] = ['id' => $id, 'name' => $a[0], 'price' => $a[2], 'duration' => $a[3], 'rate' => $a[6]];
    }

    // ------------------------------------------------------- top-up ladder
    // Bonus % rises with size to pull customers up the rungs.
    $tiers = [
        [2000,  100,  'Get started',            0],
        [3000,  300,  '10% bonus',              0],
        [5000,  500,  '10% bonus',              1],  // the £50 → £55 from the brief
        [10000, 1500, '15% bonus · popular',    0],
        [20000, 4000, '20% bonus · best value', 0],
    ];
    foreach ($tiers as $t) {
        biq_insert(
            'INSERT INTO topup_tiers (shop_id,pay_pence,bonus_pence,label,is_featured) VALUES (?,?,?,?,?)',
            [$shopId, $t[0], $t[1], $t[2], $t[3]]
        );
    }

    // ------------------------------------------------------------ customers
    $FIRST = ['James','Mohammed','Oliver','Harry','Jack','Charlie','Leo','Noah','Arthur','Alfie',
        'Tommy','Reece','Dev','Amir','Kwame','Luca','Ethan','Mason','Finlay','Rory','Sam','Zain','Kai',
        'Elliot','Marcus','Dominic','Jude','Theo','Isaac','Ryan','Callum','Owen','Nathan','Aaron','Josh',
        'Liam','Connor','Bilal','Omar','Tyrone','Andre','Sean','Declan','Craig','Wesley','Hugo','Felix',
        'Max','Toby','Joel','Yusuf','Ravi','Sanjay','Curtis','Damian','Elijah','Freddie','Gabriel',
        'Henry','Ibrahim','Jamal','Kieran'];
    $LAST = ['Smith','Patel','Jones','Williams','Brown','Taylor','Davies','Wilson','Evans','Khan',
        'Thomas','Roberts','Johnson','Lewis','Walker','Robinson','Wood','Thompson','White','Hughes',
        'Green','Hall','Edwards','Turner','Clarke','Ward','Baker','Harris','Cooper','Morris','Ali',
        'Begum','Osei','Mensah','Okafor','Nowak','Kowalski','Silva','Costa','Rossi','Murphy','Kelly',
        'Byrne','Ahmed','Hussain'];
    $AVATARS = ['🙂','😎','🧔','👨','🧑','👦','🤠','😃','🙃','😌','🥸','🤓','😁','👨‍🦱','👨‍🦰','🧑‍🦲'];

    // The one_off and tried_twice groups carry deliberately heavy weight. Every
    // real shop has a long tail who came once and never returned; without them
    // the retention figures compute to something no owner will believe.
    $profiles = [
        ['w' => 20, 'kind' => 'loyal',       'mean' => 22, 'sd' => 3,  'addon' => 1.5, 'wallet' => 0.75],
        ['w' => 18, 'kind' => 'regular',     'mean' => 29, 'sd' => 5,  'addon' => 1.0, 'wallet' => 0.40],
        ['w' => 22, 'kind' => 'one_off',     'mean' => 30, 'sd' => 10, 'addon' => 0.6, 'wallet' => 0.03, 'maxVisits' => 1],
        ['w' => 14, 'kind' => 'tried_twice', 'mean' => 34, 'sd' => 12, 'addon' => 0.7, 'wallet' => 0.08, 'maxVisits' => 2],
        ['w' => 11, 'kind' => 'casual',      'mean' => 48, 'sd' => 14, 'addon' => 0.7, 'wallet' => 0.15],
        ['w' => 10, 'kind' => 'drifting',    'mean' => 34, 'sd' => 9,  'addon' => 0.8, 'wallet' => 0.25, 'drift' => 1.6],
        ['w' => 9,  'kind' => 'lapsed',      'mean' => 28, 'sd' => 6,  'addon' => 0.9, 'wallet' => 0.30, 'stopsAfterMonth' => 6],
        ['w' => 7,  'kind' => 'new',         'mean' => 26, 'sd' => 5,  'addon' => 1.2, 'wallet' => 0.45, 'startsAfterMonth' => 9],
        ['w' => 6,  'kind' => 'vip',         'mean' => 17, 'sd' => 2,  'addon' => 2.2, 'wallet' => 0.90],
    ];
    $pool = [];
    foreach ($profiles as $p) {
        for ($i = 0; $i < $p['w']; $i++) {
            $pool[] = $p;
        }
    }

    // Enough to absorb the one-off tail and still read as a busy five-chair shop.
    $CUSTOMER_COUNT = 620;
    $used = [];
    $customers = [];
    $insCustomer = $db->prepare(
        'INSERT INTO customers (shop_id,name,email,phone,avatar_emoji,referral_code,preferred_barber_id,created_at)
         VALUES (?,?,?,?,?,?,?,?)'
    );
    $insWallet = $db->prepare('INSERT INTO wallet_accounts (customer_id) VALUES (?)');
    $codes = [];

    for ($i = 0; $i < $CUSTOMER_COUNT; $i++) {
        do {
            $name = $rng->pick($FIRST) . ' ' . $rng->pick($LAST);
        } while (isset($used[$name]));
        $used[$name] = true;

        $p = $pool[$i % count($pool)];
        $startMonth = $p['startsAfterMonth'] ?? 0;

        // Short-lifetime customers arrive steadily across the year rather than
        // all at the start, otherwise every one-off reads as lapsed 11 months
        // ago and the churn picture is a cliff instead of a trickle.
        $joined = isset($p['maxVisits'])
            ? $addDays($now, -$rng->int(10, 360))
            : $addDays($now, -(12 - $startMonth) * 30.4 + $rng->int(0, 12));

        do {
            $code = biq_seed_code($rng);
        } while (isset($codes[$code]));
        $codes[$code] = true;

        // Favourites follow demand too — the popular chair accumulates regulars.
        $pref = $rng->next() < 0.7 ? $pickBarber() : null;
        $handle = preg_replace('/[^a-z]+/', '.', strtolower($name));

        $insCustomer->execute([
            $shopId, $name, "$handle@example.com",
            '07' . $rng->int(100, 999) . ' ' . $rng->int(100000, 999999),
            $rng->pick($AVATARS), $code, $pref['id'] ?? null, $iso((int) $joined),
        ]);
        $id = (int) $db->lastInsertId();
        $insWallet->execute([$id]);

        $customers[] = [
            'id' => $id, 'name' => $name, 'profile' => $p,
            'joined' => (int) $joined, 'pref' => $pref, 'code' => $code,
        ];
    }

    // ---------------------------------------------------------- appointments
    $insAppt = $db->prepare(
        'INSERT INTO appointments (shop_id,customer_id,barber_id,service_id,starts_at,duration_min,
            status,service_pence,addons_pence,discount_pence,total_pence,paid_with,source,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    $insApptAddon = $db->prepare(
        'INSERT IGNORE INTO appointment_addons (appointment_id,addon_id,price_pence) VALUES (?,?,?)'
    );

    $taken = [];
    $freeSlot = function (int $barberId, int $dayTs) use (&$taken, $rng, $iso) {
        for ($attempt = 0; $attempt < 40; $attempt++) {
            $hour = $rng->int(9, 18);
            $minute = $rng->pick([0, 30]);
            $ts = strtotime(gmdate('Y-m-d', $dayTs) . sprintf(' %02d:%02d:00 UTC', $hour, $minute));
            $key = $barberId . '|' . $ts;
            if (!isset($taken[$key])) {
                $taken[$key] = true;
                return $ts;
            }
        }
        return null;
    };

    $completedBy = [];

    foreach ($customers as $cust) {
        $p = $cust['profile'];
        $cursor = $cust['joined'];
        $visitIndex = 0;
        $visitCap = $p['maxVisits'] ?? PHP_INT_MAX;
        $stopAt = isset($p['stopsAfterMonth'])
            ? $addDays($now, -(12 - $p['stopsAfterMonth']) * 30.4) : null;

        while ($cursor < $now) {
            if ($visitIndex >= $visitCap) {
                break;
            }
            // Drifting customers stretch their gap on each visit.
            $driftFactor = isset($p['drift']) ? 1 + ($visitIndex * ($p['drift'] - 1)) / 12 : 1;
            $gap = max(8, (int) round($rng->gauss($p['mean'] * $driftFactor, $p['sd'])));
            $cursor = $addDays($cursor, $gap);
            if ($cursor >= $now) break;
            if ($stopAt !== null && $cursor > $stopAt) break;

            // The shop trades seven days with lighter Sunday cover. Deliberate:
            // if we closed a day, demoing on that day would show £0 today and
            // the product would look broken rather than the shop looking shut.
            if ((int) gmdate('w', (int) $cursor) === 0 && $rng->next() < 0.45) {
                $cursor = $addDays($cursor, 1);
            }

            $barber = ($cust['pref'] && $rng->next() < 0.72) ? $cust['pref'] : $pickBarber();
            $slot = $freeSlot($barber['id'], (int) $cursor);
            if ($slot === null) continue;

            $service = $p['kind'] === 'vip'
                ? $rng->pick([$services[0], $services[3], $services[5]])
                : $rng->pick($services);

            $roll = $rng->next();
            $status = 'completed';
            if ($roll > 0.965)      { $status = 'no_show'; }
            elseif ($roll > 0.94)   { $status = 'cancelled'; }

            $chosen = [];
            if ($status === 'completed') {
                foreach ($addons as $a) {
                    if ($rng->next() < min(0.85, $a['rate'] * $p['addon'] * $barber['upsell'])) {
                        $chosen[] = $a;
                    }
                }
                // Beard trim and hot towel are near-substitutes; rarely both.
                $hasTowel = false;
                foreach ($chosen as $a) {
                    if ($a['name'] === 'Hot Towel Shave') { $hasTowel = true; break; }
                }
                if ($hasTowel && $rng->next() < 0.7) {
                    $chosen = array_values(array_filter($chosen, fn($a) => $a['name'] !== 'Beard Trim'));
                }
            }

            $addonsPence = array_sum(array_column($chosen, 'price'));
            $servicePence = $status === 'completed' ? $service['price'] : 0;
            $total = $servicePence + $addonsPence;

            $paid = $status !== 'completed' ? 'unpaid'
                : ($rng->next() < $p['wallet'] ? 'wallet' : ($rng->next() < 0.75 ? 'card' : 'cash'));
            $source = $visitIndex === 0
                ? ($rng->next() < 0.3 ? 'referral' : 'app')
                : ($rng->next() < 0.42 ? 'reminder' : ($rng->next() < 0.85 ? 'app' : 'walk_in'));

            $insAppt->execute([
                $shopId, $cust['id'], $barber['id'], $service['id'], $iso($slot), $service['duration'],
                $status, $servicePence, $addonsPence, 0, $total, $paid, $source,
                $iso($addDays($slot, -$rng->int(1, 9))),
            ]);
            $apptId = (int) $db->lastInsertId();
            foreach ($chosen as $a) {
                $insApptAddon->execute([$apptId, $a['id'], $a['price']]);
            }
            if ($status === 'completed') {
                $completedBy[$cust['id']][] = ['id' => $apptId, 'at' => $slot, 'total' => $total];
            }
            $visitIndex++;
        }
    }

    // --------------------------------------- upcoming week (so "today" is live)
    $active = array_values(array_filter(
        $customers,
        fn($c) => !isset($c['profile']['stopsAfterMonth']) && isset($completedBy[$c['id']])
    ));
    for ($day = 0; $day <= 6; $day++) {
        $date = $addDays($now, $day);
        $sunday = (int) gmdate('w', (int) $date) === 0;
        $count = $day === 0
            ? ($sunday ? $rng->int(11, 16) : $rng->int(19, 27))
            : ($sunday ? $rng->int(8, 13)  : $rng->int(13, 23));
        for ($i = 0; $i < $count; $i++) {
            $cust = $rng->pick($active);
            $barber = ($cust['pref'] && $rng->next() < 0.72) ? $cust['pref'] : $pickBarber();
            $slot = $freeSlot($barber['id'], (int) $date);
            if ($slot === null) continue;
            $service = $rng->pick($services);
            $isPast = $day === 0 && $slot < $now;
            $chosen = array_values(array_filter(
                $addons,
                fn($a) => $rng->next() < $a['rate'] * 1.6 * $barber['upsell']
            ));
            $addonsPence = array_sum(array_column($chosen, 'price'));
            $total = $service['price'] + $addonsPence;

            $insAppt->execute([
                $shopId, $cust['id'], $barber['id'], $service['id'], $iso($slot), $service['duration'],
                $isPast ? 'completed' : 'booked',
                $service['price'], $addonsPence, 0, $total,
                $isPast ? ($rng->next() < 0.5 ? 'wallet' : 'card') : 'unpaid',
                $rng->next() < 0.4 ? 'reminder' : 'app',
                $iso($addDays($slot, -$rng->int(1, 6))),
            ]);
            $apptId = (int) $db->lastInsertId();
            foreach ($chosen as $a) {
                $insApptAddon->execute([$apptId, $a['id'], $a['price']]);
            }
            if ($isPast) {
                $completedBy[$cust['id']][] = ['id' => $apptId, 'at' => $slot, 'total' => $total];
            }
        }
    }

    // ------------------------------------------------------- wallet history
    // Replayed chronologically so balance_after is truthful at every row.
    $insTx = $db->prepare(
        'INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,cash_delta,bonus_delta,
            balance_after,appointment_id,description,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    $walletIds = [];
    foreach (biq_all('SELECT id, customer_id FROM wallet_accounts') as $w) {
        $walletIds[(int) $w['customer_id']] = (int) $w['id'];
    }
    $updWallet = $db->prepare(
        'UPDATE wallet_accounts SET cash_pence=?, bonus_pence=?,
            lifetime_topup_pence=?, lifetime_bonus_pence=? WHERE id=?'
    );

    foreach ($customers as $cust) {
        $walletId = $walletIds[$cust['id']] ?? null;
        if (!$walletId) continue;

        $visits = $completedBy[$cust['id']] ?? [];
        usort($visits, fn($a, $b) => $a['at'] <=> $b['at']);
        $walletVisits = array_values(array_filter(
            $visits,
            fn($v) => $rng->next() < $cust['profile']['wallet']
        ));
        if (!$walletVisits) continue;

        $cash = 0; $bonus = 0; $lifeTopup = 0; $lifeBonus = 0;
        $events = [];

        // Top up when the balance would not cover the next visit, choosing the
        // smallest tier that covers the next few. Picking tiers at random
        // leaves customers sitting on £300 of credit, which inflates the wallet
        // liability into something no owner would recognise.
        $projected = 0;
        for ($i = 0, $n = count($walletVisits); $i < $n; $i++) {
            $v = $walletVisits[$i];
            if ($projected < $v['total']) {
                $horizon = array_slice($walletVisits, $i, $rng->int(2, 4));
                $needed = array_sum(array_column($horizon, 'total'));
                $tier = null;
                foreach ($tiers as $t) {
                    if ($t[0] + $t[1] >= $needed) { $tier = $t; break; }
                }
                $tier = $tier ?? $tiers[count($tiers) - 1];
                $events[] = ['type' => 'topup', 'at' => $addDays($v['at'], -$rng->int(0, 2)), 'tier' => $tier];
                $projected += $tier[0] + $tier[1];
            }
            $events[] = ['type' => 'spend', 'at' => $v['at'], 'amount' => $v['total'], 'appt' => $v['id']];
            $projected -= $v['total'];
        }
        usort($events, fn($a, $b) => $a['at'] <=> $b['at']);

        foreach ($events as $e) {
            if ($e['type'] === 'topup') {
                [$pay, $bns] = [$e['tier'][0], $e['tier'][1]];
                $cash += $pay; $bonus += $bns; $lifeTopup += $pay; $lifeBonus += $bns;
                $insTx->execute([$walletId, 'topup', $pay, 'cash', $pay, 0, $cash + $bonus, null,
                    'Top-up ' . biq_money($pay), $iso((int) $e['at'])]);
                $insTx->execute([$walletId, 'bonus', $bns, 'bonus', 0, $bns, $cash + $bonus, null,
                    'Bonus credit ' . biq_money($bns), $iso((int) $e['at'])]);
            } else {
                // Spend bonus first: protects refundable cash and burns the
                // promotional liability off the books sooner.
                $fromBonus = min($bonus, $e['amount']);
                $fromCash = min($cash, $e['amount'] - $fromBonus);
                $spent = $fromBonus + $fromCash;
                if ($spent <= 0) continue;
                $bonus -= $fromBonus; $cash -= $fromCash;
                $insTx->execute([$walletId, 'spend', -$spent, 'split', -$fromCash, -$fromBonus,
                    $cash + $bonus, $e['appt'], 'Paid for appointment', $iso((int) $e['at'])]);
            }
        }
        $updWallet->execute([$cash, $bonus, $lifeTopup, $lifeBonus, $walletId]);
    }

    // ------------------------------------------------------------ referrals
    $established = array_values(array_filter(
        $customers,
        fn($c) => count($completedBy[$c['id']] ?? []) >= 3
    ));
    $newcomers = array_values(array_filter(
        $customers,
        fn($c) => in_array($c['profile']['kind'], ['new', 'casual', 'tried_twice'], true)
    ));

    $insRef = $db->prepare(
        'INSERT IGNORE INTO referrals (shop_id,referrer_id,referred_id,code,invited_contact,
            status,reward_pence,qualifying_appointment_id,created_at,rewarded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    $setReferredBy = $db->prepare('UPDATE customers SET referred_by_id = ? WHERE id = ?');

    foreach ($newcomers as $invited) {
        if ($rng->next() > 0.55 || !$established) continue;
        $referrer = $rng->pick($established);
        if ($referrer['id'] === $invited['id']) continue;

        $visits = $completedBy[$invited['id']] ?? [];
        $qualifying = $visits[0] ?? null;
        // Reward only once the invited customer has actually been in the chair.
        $status = $qualifying ? 'rewarded' : 'signed_up';

        $insRef->execute([
            $shopId, $referrer['id'], $invited['id'], $referrer['code'], null,
            $status, 1000, $qualifying['id'] ?? null,
            $iso($addDays($invited['joined'], -$rng->int(1, 5))),
            $qualifying ? $iso($qualifying['at']) : null,
        ]);
        if ($db->lastInsertId() && $insRef->rowCount() > 0) {
            $setReferredBy->execute([$referrer['id'], $invited['id']]);
            if ($status === 'rewarded') {
                foreach ([$referrer['id'], $invited['id']] as $side) {
                    $wid = $walletIds[$side] ?? null;
                    if (!$wid) continue;
                    $cur = biq_one('SELECT cash_pence, bonus_pence FROM wallet_accounts WHERE id = ?', [$wid]);
                    $nb = (int) $cur['bonus_pence'] + 1000;
                    biq_exec('UPDATE wallet_accounts SET bonus_pence = ? WHERE id = ?', [$nb, $wid]);
                    $insTx->execute([$wid, 'referral_credit', 1000, 'bonus', 0, 1000,
                        (int) $cur['cash_pence'] + $nb, null, 'Referral reward £10.00',
                        $iso($qualifying['at'])]);
                }
            }
        }
    }

    // Some invitations sent but never claimed — realistic funnel leakage.
    $insOpen = $db->prepare(
        'INSERT INTO referrals (shop_id,referrer_id,referred_id,code,invited_contact,status,reward_pence,created_at)
         VALUES (?,?,NULL,?,?,?,?,?)'
    );
    foreach (array_slice($established, 0, 14) as $referrer) {
        $n = $rng->int(1, 3);
        for ($i = 0; $i < $n; $i++) {
            $insOpen->execute([
                $shopId, $referrer['id'], $referrer['code'],
                '07' . $rng->int(100, 999) . $rng->int(100000, 999999),
                $rng->next() < 0.3 ? 'expired' : 'sent', 1000,
                $iso($addDays($now, -$rng->int(5, 120))),
            ]);
        }
    }

    // Commit the bulk data before building reminders: the reminder engine reads
    // back the history it is predicting from, and keeping that in a separate
    // unit of work makes a partial failure easier to reason about.
    $db->commit();

    // ------------------------------------------------------------ reminders
    // Generated by the same engine the app uses at runtime, so the seeded state
    // and live behaviour cannot drift apart.
    $reminderCount = biq_rebuild_reminders();

    return [
        'customers'    => count($customers),
        'barbers'      => count($barbers),
        'appointments' => (int) biq_val('SELECT COUNT(*) FROM appointments'),
        'completed'    => (int) biq_val("SELECT COUNT(*) FROM appointments WHERE status='completed'"),
        'revenue_pence' => (int) biq_val("SELECT COALESCE(SUM(total_pence),0) FROM appointments WHERE status='completed'"),
        'wallet_txns'  => (int) biq_val('SELECT COUNT(*) FROM wallet_transactions'),
        'referrals'    => (int) biq_val('SELECT COUNT(*) FROM referrals'),
        'reminders'    => $reminderCount,
    ];
}

function biq_seed_code(BiqRng $rng, int $len = 6): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < $len; $i++) {
        $out .= $alphabet[$rng->int(0, strlen($alphabet) - 1)];
    }
    return $out;
}
