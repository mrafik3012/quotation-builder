<?php
declare(strict_types=1);
/**
 * Scheduled jobs - OPTIONAL. The app also runs them by itself in the background (see maybe_run_jobs), so a cron job
 * is a belt-and-braces extra that makes sure they run even on days nobody signs in.
 *   Hostinger hPanel > Advanced > Cron Jobs:   /usr/bin/php /full/path/to/api/cron.php
 *   or from any scheduler:                     curl -s "https://YOUR-DOMAIN/api/cron.php?key=CRON_KEY"
 */
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/jobs.php';

$cli = PHP_SAPI === 'cli';
if (!$cli) {
    header('Content-Type: text/plain; charset=utf-8'); header('Cache-Control: no-store');
    try { config(); ensure_schema(); } catch (Throwable $e) { http_response_code(503); echo "not installed\n"; exit; }
    $key = (string)get_setting('cron_key');
    if ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? ''))) { http_response_code(403); echo "forbidden\n"; exit; }
} else {
    config(); ensure_schema();
}
$force = $cli ? in_array('--force', $argv ?? [], true) : !empty($_GET['force']);
echo implode("\n", run_jobs($force)) . "\n";
