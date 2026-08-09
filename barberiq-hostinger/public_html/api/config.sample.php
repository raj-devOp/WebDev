<?php
/**
 * BarberIQ configuration.
 *
 * The installer writes this file for you. If you would rather do it by hand,
 * copy this to `config.php` and fill in the four database values from
 * hPanel → Databases → Management.
 *
 * Keep config.php out of any public listing — it holds your database password.
 * The .htaccess in this folder already blocks direct access to it.
 */

return [
    // ---------------------------------------------------------------- database
    // From hPanel → Databases → MySQL Databases. On Hostinger the host is
    // almost always 'localhost' and the user/database names are prefixed with
    // your account id, e.g. u123456789_barberiq.
    'db_host' => 'localhost',
    'db_name' => 'u000000000_barberiq',
    'db_user' => 'u000000000_barberiq',
    'db_pass' => 'CHANGE_ME',
    'db_port' => 3306,

    // ------------------------------------------------------------------- owner
    // Password for the owner dashboard. CHANGE THIS before you go live.
    //
    // This app is reachable by anyone who knows the URL, so without a password
    // your takings, customer list and phone numbers are public. Generate a hash
    // with:  php -r "echo password_hash('your-password', PASSWORD_DEFAULT);"
    // and paste it below. Leave 'owner_password_hash' empty to disable the gate
    // entirely — only sensible on a private staging URL.
    'owner_password_hash' => '',

    // -------------------------------------------------------------------- misc
    'timezone' => 'Europe/London',

    // Demo mode exposes the persona switcher and the "reset demo data" button.
    // Set this to false once a real shop is using it, or customers can view
    // each other's wallets.
    'demo_mode' => true,

    // Show PHP errors in API responses. Useful while setting up, but turn it
    // off afterwards — error text can leak table and column names.
    'debug' => false,
];
