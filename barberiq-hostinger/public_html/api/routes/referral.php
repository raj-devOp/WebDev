<?php
/**
 * D. REFERRAL
 *
 * £10 each way. The referrer's credit unlocks only after the invited friend
 * completes a first visit — that rule lives in booking.php's complete handler,
 * and it is the single most important control in the feature.
 */

declare(strict_types=1);

function biq_route_referral(int $customerId): void
{
    $c = biq_require_customer($customerId);
    $cid = (int) $c['id'];

    $rows = array_map(
        fn($r) => biq_numeric($r, ['id', 'referrer_id', 'referred_id', 'reward_pence']),
        biq_all(
            'SELECT r.*, cu.name AS referred_name, cu.avatar_emoji AS referred_emoji
               FROM referrals r
               LEFT JOIN customers cu ON cu.id = r.referred_id
              WHERE r.referrer_id = ? ORDER BY r.created_at DESC',
            [$cid]
        )
    );

    $earned = 0;
    $rewardedCount = 0;
    $pending = 0;
    foreach ($rows as $r) {
        if ($r['status'] === 'rewarded') {
            $earned += $r['reward_pence'];
            $rewardedCount++;
        } elseif (in_array($r['status'], ['sent', 'signed_up'], true)) {
            $pending++;
        }
    }

    // Shop-wide leaderboard: social proof is what makes a referral scheme spread.
    $leaderboard = array_map(
        fn($l) => biq_numeric($l, ['id', 'rewarded', 'earned_pence']),
        biq_all(
            "SELECT c.id, c.name, c.avatar_emoji,
                    COUNT(r.id) AS rewarded,
                    COUNT(r.id) * MAX(r.reward_pence) AS earned_pence
               FROM customers c
               JOIN referrals r ON r.referrer_id = c.id AND r.status = 'rewarded'
              WHERE c.shop_id = ?
              GROUP BY c.id, c.name, c.avatar_emoji
              ORDER BY rewarded DESC, c.name LIMIT 8",
            [BIQ_SHOP_ID]
        )
    );

    $myRank = 1 + (int) biq_val(
        "SELECT COUNT(*) FROM (
            SELECT referrer_id, COUNT(*) n FROM referrals
             WHERE shop_id = ? AND status = 'rewarded'
             GROUP BY referrer_id
            HAVING n > (SELECT COUNT(*) FROM referrals
                         WHERE referrer_id = ? AND status = 'rewarded')
         ) t",
        [BIQ_SHOP_ID, $cid]
    );

    $scheme = ($_SERVER['HTTPS'] ?? '') && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';

    biq_json([
        'code' => $c['referral_code'],
        'share_url' => "$scheme://$host/?ref=" . $c['referral_code'],
        'reward_pence' => 1000,
        'referrals' => $rows,
        'stats' => [
            'total' => count($rows),
            'rewarded' => $rewardedCount,
            'pending' => $pending,
            'earned_pence' => $earned,
            'rank' => $myRank,
        ],
        'leaderboard' => $leaderboard,
        'terms' => [
            'Your friend gets £10 credit when they sign up with your code.',
            'You get £10 credit once they have completed their first paid visit.',
            'Credit lands in both wallets automatically — nothing to claim.',
            'One reward per new customer. Existing customers do not qualify.',
        ],
    ]);
}

function biq_route_invite(int $customerId): void
{
    $c = biq_require_customer($customerId);
    $contact = biq_str(biq_body()['contact'] ?? '', 190);
    if (mb_strlen($contact) < 5) {
        biq_fail('Enter a mobile number or email address.');
    }

    // Do not let someone invite a contact who is already a customer.
    $existing = biq_val(
        'SELECT id FROM customers WHERE shop_id = ? AND (email = ? OR phone = ?)',
        [BIQ_SHOP_ID, $contact, $contact]
    );
    if ($existing) {
        biq_fail('That person is already a customer, so the invite would not qualify.');
    }

    $dupe = biq_val(
        "SELECT id FROM referrals
          WHERE referrer_id = ? AND invited_contact = ? AND status IN ('sent','signed_up')",
        [(int) $c['id'], $contact]
    );
    if ($dupe) {
        biq_fail('You have already invited that contact.');
    }

    $id = biq_insert(
        "INSERT INTO referrals (shop_id, referrer_id, code, invited_contact, status, reward_pence)
         VALUES (?,?,?,?,'sent',1000)",
        [BIQ_SHOP_ID, (int) $c['id'], $c['referral_code'], $contact]
    );

    biq_json([
        'ok' => true,
        'referral_id' => $id,
        'message' => "Invite sent to $contact. You'll both get £10 once they've had their first cut.",
    ], 201);
}

/**
 * Demo control: simulate the invited friend signing up.
 *
 * Deliberately does NOT pay out — that only happens on a completed visit, which
 * is the point of showing this in a demo.
 */
function biq_route_simulate_signup(int $referralId): void
{
    if (empty(biq_config()['demo_mode'])) {
        biq_fail('Demo controls are disabled on this installation.', 403);
    }
    $ref = biq_one("SELECT * FROM referrals WHERE id = ? AND status = 'sent'", [$referralId]);
    if (!$ref) {
        biq_fail('No open invitation with that id.', 404);
    }

    $name = biq_str(biq_body()['name'] ?? 'New Friend', 60) ?: 'New Friend';

    $newId = biq_transaction(function () use ($ref, $name, $referralId) {
        $handle = preg_replace('/[^a-z]+/', '.', mb_strtolower($name));
        $id = biq_insert(
            'INSERT INTO customers
                (shop_id, name, email, phone, avatar_emoji, referral_code, referred_by_id)
             VALUES (?,?,?,?,?,?,?)',
            [
                BIQ_SHOP_ID, $name,
                $handle . '.' . time() . '@example.com',
                $ref['invited_contact'], '🆕', biq_code(6), (int) $ref['referrer_id'],
            ]
        );
        biq_insert('INSERT INTO wallet_accounts (customer_id) VALUES (?)', [$id]);
        biq_exec(
            "UPDATE referrals SET referred_id = ?, status = 'signed_up' WHERE id = ?",
            [$id, $referralId]
        );
        return $id;
    });

    biq_json([
        'ok' => true,
        'customer_id' => $newId,
        'message' => "$name signed up. Reward unlocks after their first completed visit — "
            . 'book and complete one to release both £10 credits.',
    ], 201);
}
