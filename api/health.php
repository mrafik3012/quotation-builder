<?php
declare(strict_types=1);
// Uptime-monitor endpoint (UptimeRobot, Better Stack, ...). GET /api/health.php  ->  200 {"status":"ok"} or 503.
// With ?key=<cron key from Settings> it also reports backup age, last cron run and recent errors (no personal data).
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
try {
    config();
    $t0 = microtime(true);
    $v = (int)(get_setting('schema_v') ?? 0);
    $ms = (int)round((microtime(true) - $t0) * 1000);
    $out = ['status' => 'ok', 'time' => date('c')];
    $key = (string)get_setting('cron_key');
    if ($key !== '' && isset($_GET['key']) && hash_equals($key, (string)$_GET['key'])) {
        $files = backup_files(); $last = $files ? strtotime($files[0]['at']) : 0;
        $cron = get_setting('cron_last_run');
        $out += ['schema' => $v, 'db_ms' => $ms, 'last_backup_hours' => $last ? round((time() - $last) / 3600, 1) : null, 'cron_last_run' => $cron ?: null, 'cron_overdue' => $cron ? (time() - strtotime($cron) > 172800) : true, 'errors_24h' => count(app_errors_since(86400)), 'disk_free_mb' => (int)(@disk_free_space(__DIR__) / 1048576)];
        if ($out['cron_overdue'] || ($last && time() - $last > 172800)) $out['status'] = 'degraded';
    }
    echo json_encode($out);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['status' => 'down']);
}
