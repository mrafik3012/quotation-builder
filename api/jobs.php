<?php
declare(strict_types=1);
// Scheduled jobs, shared by api/cron.php (real cron) and the opportunistic runner (maybe_run_jobs) that keeps the
// app self-maintaining on hosts where no cron job has been set up.
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/projects.php';
require_once __DIR__ . '/mail.php';

/** Run a job at most once per $everySec (stored in settings so overlapping runs are harmless). */
function cron_due(string $job, int $everySec, bool $force): bool
{
    $last = (int)(get_setting('cron_job_' . $job) ?: 0);
    if (!$force && time() - $last < $everySec) return false;
    set_setting('cron_job_' . $job, (string)time());
    return true;
}

/** Run every job. Returns the log lines. */
function run_jobs(bool $force = false): array
{
    $log = [];
    $say = function (string $m) use (&$log) { $log[] = $m; };
    $prev = $GLOBALS['FAIL_THROWS'] ?? false;
    $GLOBALS['FAIL_THROWS'] = true;
    try {
        if (cron_due('backup', 72000, $force)) {
            try { [$n, $b] = backup_to_disk(); $say("backup: wrote $n (" . round($b / 1024) . ' KB)'); }
            catch (Throwable $e) { app_log_error('Backup failed: ' . $e->getMessage()); $say('backup: FAILED - ' . $e->getMessage()); }
        } else $say('backup: not due');

        if (mail_configured() && cron_due('digest', 72000, $force)) {
            $d = digest_data();
            $total = count($d['followups']) + count($d['overdue']) + count($d['amc']) + count($d['expiring']) + ($d['errors'] ? 1 : 0);
            if ($total > 0) {
                $html = digest_html($d); $sent = 0;
                foreach (q("SELECT email FROM users WHERE role = 'admin'")->fetchAll() as $u) { [$ok] = send_mail($u['email'], 'Daily summary: ' . $total . ' item(s) need attention', $html); $sent += $ok ? 1 : 0; }
                $say("digest: $total item(s), e-mailed to $sent admin(s)");
            } else $say('digest: nothing to report');
        } else $say('digest: ' . (mail_configured() ? 'not due' : 'e-mail not configured'));

        if (mail_configured() && get_setting('client_reminders') === '1' && cron_due('reminders', 3600, $force)) {
            $n = client_reminders(); $say("client reminders: $n sent");
        } else $say('client reminders: ' . (get_setting('client_reminders') === '1' ? 'not due' : 'off'));

        if (mail_configured() && get_setting('overdue_reminders') === '1' && cron_due('overdue', 72000, $force)) {
            $n = overdue_reminders(); $say("overdue payment reminders: $n sent");
        } else $say('overdue payment reminders: ' . (get_setting('overdue_reminders') === '1' ? 'not due' : 'off'));

        q('DELETE FROM rate_limits WHERE window_start < ?', [time() - 7200]);
        q('DELETE FROM password_resets WHERE expires_at < ?', [date('Y-m-d H:i:s', time() - 86400)]);
        q('DELETE FROM oauth_codes WHERE expires_at < ?', [time() - 3600]);
        q('DELETE FROM oauth_refresh WHERE expires_at < ? OR revoked = 1', [time() - 86400 * 7]);
        q("DELETE FROM api_tokens WHERE oauth_client IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?", [date('Y-m-d H:i:s', time() - 86400 * 7)]);
        q('DELETE FROM email_log WHERE created_at < ?', [date('Y-m-d H:i:s', time() - 86400 * 90)]);
        $say('housekeeping: done');
        set_setting('cron_last_run', now());
    } catch (Throwable $e) {
        app_log_error('Jobs failed: ' . $e->getMessage());
        $say('ERROR: ' . $e->getMessage());
    }
    $GLOBALS['FAIL_THROWS'] = $prev;
    return $log;
}

/**
 * Self-running: called (throttled to once an hour, atomically claimed) from a background request after sign-in,
 * so backups, digests and reminders happen even if nobody set up a cron job. A real cron job still works and is
 * preferred; every job protects itself against running twice.
 */
function maybe_run_jobs(): ?array
{
    if (get_setting('auto_jobs') === '0') return null;
    $now = time();
    $last = (int)(get_setting('auto_jobs_at') ?: 0);
    if ($now - $last < 3600) return null;
    $st = q('UPDATE settings SET v = ? WHERE k = ? AND v = ?', [(string)$now, 'auto_jobs_at', (string)$last]);   // atomic claim
    if ($st->rowCount() !== 1) { if (get_setting('auto_jobs_at') !== null) return null; set_setting('auto_jobs_at', (string)$now); }
    return run_jobs(false);
}

/** Run $fn after the HTTP response has been sent (falls back to running at the end of the request). */
function after_response(callable $fn): void
{
    register_shutdown_function(function () use ($fn) {
        if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
        elseif (function_exists('litespeed_finish_request')) @litespeed_finish_request();
        try { $fn(); } catch (Throwable $e) { app_log_error('Background task failed: ' . $e->getMessage()); }
    });
}

/** E-mail every admin (and optionally one extra address) - used for client activity notifications. */
function notify_admins(string $subject, string $heading, string $bodyHtml, ?array $button = null, ?string $extra = null): void
{
    if (get_setting('notify_events') === '0' || !mail_configured()) return;
    $to = array_column(q("SELECT email FROM users WHERE role = 'admin'")->fetchAll(), 'email');
    if ($extra && filter_var($extra, FILTER_VALIDATE_EMAIL)) $to[] = $extra;
    $html = email_html($heading, $bodyHtml, $button);
    foreach (array_unique($to) as $addr) send_mail($addr, $subject, $html);
}

/** Polite e-mail to the client for each overdue milestone: at most 3, one week apart. */
function overdue_reminders(): int
{
    $sent = 0; $today = date('Y-m-d');
    $rows = q("SELECT m.id, m.label, m.due_date, p.id AS pid, p.name, p.quote_no, p.client_id,
        m.amount - COALESCE((SELECT SUM(c.amount) FROM credit_notes c WHERE c.milestone_id = m.id),0) - COALESCE((SELECT SUM(r.amount) FROM project_receipts r WHERE r.milestone_id = m.id),0) AS due
        FROM project_milestones m JOIN projects p ON p.id = m.project_id WHERE m.due_date IS NOT NULL AND m.due_date < ? AND p.status = 'active' ORDER BY m.due_date LIMIT 100", [$today])->fetchAll();
    $co = (string)(get_setting('company_name') ?: 'Infraura');
    foreach ($rows as $r) {
        if ((float)$r['due'] <= 0.01) continue;
        $cl = $r['client_id'] ? q('SELECT name, email, contact_person FROM clients WHERE id = ?', [$r['client_id']])->fetch() : null;
        if (!$cl || !filter_var($cl['email'] ?? '', FILTER_VALIDATE_EMAIL)) continue;
        $key = 'pay:' . $r['id'];
        $ev = q("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM quote_events WHERE quote_no = ? AND type = 'payment_reminder' AND actor = ?", [$r['quote_no'], $key])->fetch();
        if ((int)$ev['n'] >= 3) continue;
        if ((int)$ev['n'] > 0 && time() - strtotime((string)$ev['last']) < 7 * 86400) continue;
        $e = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
        $html = '<p>Dear ' . $e($cl['contact_person'] ?: $cl['name']) . ',</p><p>A friendly reminder that the payment of <b>Rs ' . number_format((float)$r['due'], 2) . '</b> for <b>' . $e($r['label']) . '</b> (' . $e($r['name']) . ') was due on ' . $e(date('d-m-Y', strtotime((string)$r['due_date']))) . '. If you have already paid, please ignore this message; otherwise we would appreciate it at your earliest convenience.</p>';
        [$ok] = send_mail($cl['email'], 'Payment reminder: ' . $r['label'] . ' - ' . $co, email_html('Payment reminder', $html));
        if ($ok) { q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$r['quote_no'], 0, 'payment_reminder', json_encode(['n' => (int)$ev['n'] + 1, 'due' => $r['due']]), $key, null, now()]); $sent++; }
    }
    return $sent;
}

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
