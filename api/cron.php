<?php
declare(strict_types=1);
/**
 * Scheduled jobs - run once a day (or every 15-60 minutes; every job protects itself against running twice).
 *   Hostinger hPanel > Advanced > Cron Jobs:   /usr/bin/php /full/path/to/api/cron.php
 *   or from any scheduler:                     curl -s "https://YOUR-DOMAIN/api/cron.php?key=CRON_KEY"
 * Jobs: nightly backup, e-mail digest to admins (follow-ups, overdue payments, AMC renewals, expiring quotes, errors),
 *       optional polite client reminders, housekeeping.
 */
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/projects.php';
require __DIR__ . '/mail.php';

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
$GLOBALS['FAIL_THROWS'] = true;
$log = [];
$say = function (string $m) use (&$log, $cli) { $log[] = $m; };

/** Run a job at most once per $everySec (stored in settings so overlapping cron runs are harmless). */
function cron_due(string $job, int $everySec, bool $force): bool
{
    $last = (int)(get_setting('cron_job_' . $job) ?: 0);
    if (!$force && time() - $last < $everySec) return false;
    set_setting('cron_job_' . $job, (string)time());
    return true;
}

try {
    // ---- 1. backup (at most every ~20 hours)
    if (cron_due('backup', 72000, $force)) {
        try { [$n, $b] = backup_to_disk(); $say("backup: wrote $n (" . round($b / 1024) . ' KB)'); }
        catch (Throwable $e) { app_log_error('Backup failed: ' . $e->getMessage()); $say('backup: FAILED - ' . $e->getMessage()); }
    } else $say('backup: not due');

    // ---- 2. daily digest to admins
    if (mail_configured() && cron_due('digest', 72000, $force)) {
        $d = digest_data();
        $total = count($d['followups']) + count($d['overdue']) + count($d['amc']) + count($d['expiring']) + ($d['errors'] ? 1 : 0);
        if ($total > 0) {
            $html = digest_html($d); $sent = 0;
            foreach (q("SELECT email FROM users WHERE role = 'admin'")->fetchAll() as $u) { [$ok] = send_mail($u['email'], 'Daily summary: ' . $total . ' item(s) need attention', $html); $sent += $ok ? 1 : 0; }
            $say("digest: $total item(s), e-mailed to $sent admin(s)");
        } else $say('digest: nothing to report');
    } else $say('digest: ' . (mail_configured() ? 'not due' : 'e-mail not configured'));

    // ---- 3. client reminders (opt-in)
    if (mail_configured() && get_setting('client_reminders') === '1' && cron_due('reminders', 3600, $force)) {
        $n = client_reminders(); $say("client reminders: $n sent");
    } else $say('client reminders: ' . (get_setting('client_reminders') === '1' ? 'not due' : 'off'));

    // ---- 4. housekeeping
    q('DELETE FROM rate_limits WHERE window_start < ?', [time() - 7200]);
    q('DELETE FROM password_resets WHERE expires_at < ?', [date('Y-m-d H:i:s', time() - 86400)]);
    q('DELETE FROM oauth_codes WHERE expires_at < ?', [time() - 3600]);
    q('DELETE FROM oauth_refresh WHERE expires_at < ? OR revoked = 1', [time() - 86400 * 7]);
    q("DELETE FROM api_tokens WHERE oauth_client IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?", [date('Y-m-d H:i:s', time() - 86400 * 7)]);
    q('DELETE FROM email_log WHERE created_at < ?', [date('Y-m-d H:i:s', time() - 86400 * 90)]);
    $say('housekeeping: done');
    set_setting('cron_last_run', now());
} catch (Throwable $e) {
    app_log_error('Cron failed: ' . $e->getMessage());
    $say('ERROR: ' . $e->getMessage());
}
echo implode("\n", $log) . "\n";

/* ---------------------------------------------------------------- */
function digest_data(): array
{
    $today = date('Y-m-d');
    $follow = q("SELECT q.quote_no, q.client_json, q.total, q.updated_at, q.id FROM quotes q WHERE q.is_latest = 1 AND q.status = 'sent' AND q.updated_at <= ? ORDER BY q.updated_at LIMIT 15", [date('Y-m-d H:i:s', strtotime('-3 days'))])->fetchAll();
    $overdue = q("SELECT p.id AS pid, p.name, m.label, m.due_date, m.amount - COALESCE((SELECT SUM(c.amount) FROM credit_notes c WHERE c.milestone_id = m.id),0) - COALESCE((SELECT SUM(r.amount) FROM project_receipts r WHERE r.milestone_id = m.id),0) AS due
        FROM project_milestones m JOIN projects p ON p.id = m.project_id WHERE m.due_date IS NOT NULL AND m.due_date < ? AND p.status <> 'completed'
        AND m.amount - COALESCE((SELECT SUM(c.amount) FROM credit_notes c WHERE c.milestone_id = m.id),0) - COALESCE((SELECT SUM(r.amount) FROM project_receipts r WHERE r.milestone_id = m.id),0) > 0.01 ORDER BY m.due_date LIMIT 20", [$today])->fetchAll();
    $amc = q('SELECT id, name, amc_end FROM projects WHERE amc_end IS NOT NULL AND amc_end <> \'\' AND amc_end >= ? AND amc_end <= ? ORDER BY amc_end LIMIT 20', [$today, date('Y-m-d', strtotime('+30 days'))])->fetchAll();
    $exp = q("SELECT quote_no, client_json, total, valid_until, id FROM quotes WHERE is_latest = 1 AND status = 'sent' AND valid_until >= ? AND valid_until <= ? ORDER BY valid_until LIMIT 15", [$today, date('Y-m-d', strtotime('+3 days'))])->fetchAll();
    return ['followups' => $follow, 'overdue' => $overdue, 'amc' => $amc, 'expiring' => $exp, 'errors' => app_errors_since(86400)];
}

function digest_html(array $d): string
{
    $e = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
    $cn = fn($r) => $e((json_decode((string)$r['client_json'], true) ?: [])['name'] ?? '');
    $inr = fn($v) => 'Rs ' . number_format((float)$v, 0);
    $base = app_base_url();
    $sec = function (string $title, array $rows, callable $line) use ($e) { return $rows ? '<h3 style="margin:18px 0 6px;font-size:15px">' . $e($title) . ' (' . count($rows) . ')</h3><ul style="margin:0;padding-left:18px">' . implode('', array_map(fn($r) => '<li style="margin:3px 0">' . $line($r) . '</li>', $rows)) . '</ul>' : ''; };
    $html = $sec('Quotes sent 3+ days ago with no reply', $d['followups'], fn($r) => '<a href="' . $base . '/index.html#/quotes/' . (int)$r['id'] . '">' . $e($r['quote_no']) . '</a> - ' . $cn($r) . ' - ' . $inr($r['total']))
        . $sec('Overdue payments', $d['overdue'], fn($r) => '<a href="' . $base . '/index.html#/projects/' . (int)$r['pid'] . '">' . $e($r['name']) . '</a> - ' . $e($r['label']) . ' - ' . $inr($r['due']) . ' (due ' . $e(date('d-m-Y', strtotime($r['due_date']))) . ')')
        . $sec('AMC / warranty renewals in the next 30 days', $d['amc'], fn($r) => '<a href="' . $base . '/index.html#/projects/' . (int)$r['id'] . '">' . $e($r['name']) . '</a> - ends ' . $e(date('d-m-Y', strtotime($r['amc_end']))))
        . $sec('Quotes expiring within 3 days', $d['expiring'], fn($r) => '<a href="' . $base . '/index.html#/quotes/' . (int)$r['id'] . '">' . $e($r['quote_no']) . '</a> - ' . $cn($r) . ' - ' . $inr($r['total']) . ' (valid until ' . $e(date('d-m-Y', strtotime($r['valid_until']))) . ')')
        . ($d['errors'] ? '<h3 style="margin:18px 0 6px;font-size:15px;color:#b91c1c">' . count($d['errors']) . ' application error(s) in the last 24 hours</h3><p style="margin:0;font-size:13px">Latest: ' . $e($d['errors'][count($d['errors']) - 1]['msg']) . '</p>' : '');
    return email_html('Daily summary', $html, ['Open the app', $base . '/index.html']);
}

function client_reminders(): int
{
    $sent = 0; $today = date('Y-m-d');
    $rows = q("SELECT * FROM quotes WHERE is_latest = 1 AND status = 'sent' AND valid_until >= ? LIMIT 200", [$today])->fetchAll();
    foreach ($rows as $row) {
        $cl = json_decode((string)$row['client_json'], true) ?: [];
        if (!filter_var($cl['email'] ?? '', FILTER_VALIDATE_EMAIL)) continue;
        $ev = q("SELECT type, MAX(created_at) AS last, COUNT(*) AS n FROM quote_events WHERE quote_no = ? AND type IN ('emailed','shared','reminder') GROUP BY type", [$row['quote_no']])->fetchAll();
        $by = []; foreach ($ev as $x) $by[$x['type']] = $x;
        $reminders = (int)($by['reminder']['n'] ?? 0);
        if ($reminders >= 2) continue;
        $lastSend = max(strtotime((string)($by['emailed']['last'] ?? '1970-01-01')), strtotime((string)($by['shared']['last'] ?? '1970-01-01')), strtotime((string)$row['updated_at']) * 0);
        $anchor = $reminders === 0 ? ($lastSend ?: strtotime((string)$row['updated_at'])) : strtotime((string)$by['reminder']['last']);
        $needDays = $reminders === 0 ? 3 : 4;
        if (time() - $anchor < $needDays * 86400) continue;
        $tok = ensure_share_token($row, ['name' => 'cron']);
        $co = (string)(get_setting('company_name') ?: 'Infraura');
        $html = '<p>Dear ' . htmlspecialchars($cl['contact_person'] ?: ($cl['name'] ?? ''), ENT_QUOTES, 'UTF-8') . ',</p><p>A gentle reminder about quotation <b>' . htmlspecialchars($row['quote_no'], ENT_QUOTES, 'UTF-8') . '</b>' . ($row['title'] ? ' (' . htmlspecialchars($row['title'], ENT_QUOTES, 'UTF-8') . ')' : '') . ', valid until ' . htmlspecialchars(date('d-m-Y', strtotime((string)$row['valid_until'])), ENT_QUOTES, 'UTF-8') . '. We are happy to clarify anything or revise it for you.</p>';
        [$ok] = send_mail($cl['email'], 'Reminder: quotation ' . $row['quote_no'] . ' from ' . $co, email_html('Quotation ' . $row['quote_no'], $html, ['View quotation', app_base_url() . '/view.html?t=' . $tok]));
        if ($ok) { log_event($row['quote_no'], (int)$row['rev'], 'reminder', ['n' => $reminders + 1], 'cron'); $sent++; }
    }
    return $sent;
}
