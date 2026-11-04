<?php
// Router for PHP's built-in server so tests can use the same "pretty" discovery URLs that .htaccess provides on Apache.
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/\.well-known/oauth-(authorization-server|protected-resource)(/.*)?$#', $p, $m)) { $_GET['r'] = 'wk-' . $m[1]; require __DIR__ . '/../api/oauth.php'; return true; }
if ($p === '/api/.well-known/openid-configuration' || $p === '/api/.well-known/oauth-authorization-server') { $_GET['r'] = 'as-metadata'; require __DIR__ . '/../api/oauth.php'; return true; }
return false;
