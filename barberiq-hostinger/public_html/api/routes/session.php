<?php
/** Owner login / logout. */

declare(strict_types=1);

function biq_route_session(): void
{
    biq_json([
        'is_owner' => biq_is_owner(),
        'gate_enabled' => biq_owner_gate_enabled(),
    ]);
}

function biq_route_login(): void
{
    $password = (string) (biq_body()['password'] ?? '');
    if ($password === '') {
        biq_fail('Enter the owner password.');
    }
    if (!biq_owner_login($password)) {
        biq_fail('That password is not right.', 401);
    }
    biq_json(['ok' => true, 'is_owner' => true]);
}

function biq_route_logout(): void
{
    biq_owner_logout();
    biq_json(['ok' => true, 'is_owner' => false]);
}
