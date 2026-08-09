<?php
/**
 * Router for PHP's built-in server, used only for local testing.
 *
 * It emulates the .htaccess rewrite so the same URLs work under
 * `php -S localhost:8080 -t public_html router.php` as they will on Hostinger's
 * Apache/LiteSpeed. Not uploaded to the host — Apache handles this there.
 */

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = __DIR__ . '/public_html';

// Serve real files as-is.
$file = $root . $uri;
if ($uri !== '/' && is_file($file)) {
    return false;
}

// /api/... → api/index.php?route=...
if (preg_match('#^/api/(.*)$#', $uri, $m)) {
    $_GET['route'] = $m[1];
    $_SERVER['SCRIPT_NAME'] = '/api/index.php';
    require $root . '/api/index.php';
    return true;
}

// Directory index for /install/ etc.
if (is_dir($file) && is_file(rtrim($file, '/') . '/index.php')) {
    require rtrim($file, '/') . '/index.php';
    return true;
}

// SPA fallback.
require $root . '/index.html';
return true;
