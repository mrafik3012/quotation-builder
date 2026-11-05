<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/projects.php';
require __DIR__ . '/mail.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/jobs.php';
start_session();

$method = $_SERVER['REQUEST_METHOD'];
$parts = array_values(array_filter(explode('/', trim((string)($_GET['r'] ?? ''), '/')), 'strlen'));
$GLOBALS['parts'] = $parts;
$a = $parts[0] ?? '';
$b = $parts[1] ?? null;
$c = $parts[2] ?? null;

if ($method !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'infraura') {
    fail('Bad request', 403);
}

try {
    route($method, $a, $b, $c);
} catch (PDOException $e) {
    error_log('DB error: ' . $e->getMessage());
    app_log_error('DB error: ' . $e->getMessage());
    fail('Database error', 500);
} catch (Throwable $e) {
    error_log('Error: ' . $e->getMessage());
    app_log_error('Error: ' . $e->getMessage());
    fail('Server error', 500);
}

function route(string $m, string $a, ?string $b, ?string $c): void
{
    // ---- auth ----
    if ($a === 'auth') {
        if ($b === 'login' && $m === 'POST') {
            ensure_schema();
            $r = authenticate(body());          // password + optional 2FA, lockouts, recovery codes (shared with the OAuth consent page)
            if (!empty($r['need_2fa'])) json_out(['need_2fa' => true]);
            $u = $r['user'];
            session_regenerate_id(true);
            $_SESSION['user'] = ['id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email'], 'role' => $u['role']];
            $_SESSION['must_change'] = (int)$u['must_change_password'] === 1;
            json_out(['user' => $_SESSION['user'], 'must_change' => $_SESSION['must_change']]);
        }
        if ($b === 'logout' && $m === 'POST') {
            $_SESSION = [];
            session_destroy();
            json_out(['ok' => true]);
        }
        if ($b === 'me' && $m === 'GET') {
            $cu = current_user();
            if ($cu) { ensure_schema(); $row = q('SELECT totp_enabled FROM users WHERE id = ?', [$cu['id']])->fetch(); $cu['totp'] = $row ? (int)$row['totp_enabled'] === 1 : false; }
            json_out(['user' => $cu, 'must_change' => !empty($_SESSION['must_change'])]);
        }
        if ($b === 'password' && $m === 'POST') {
            $u = require_auth();
            $d = body();
            $row = q('SELECT password_hash FROM users WHERE id = ?', [$u['id']])->fetch();
            if (!password_verify((string)($d['current'] ?? ''), $row['password_hash'])) fail('Current password is wrong');
            $new = (string)($d['new'] ?? '');
            if (strlen($new) < 8) fail('New password must be at least 8 characters');
            if ($new === (string)($d['current'] ?? '')) fail('Choose a password different from the current one');
            q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [password_hash($new, PASSWORD_DEFAULT), $u['id']]);
            $_SESSION['must_change'] = false;
            audit($u, 'password.change', $u['email']);
            json_out(['ok' => true]);
        }
        if ($b === 'forgot' && $m === 'POST') {           // always answers the same way so it cannot be used to discover accounts
            ensure_schema();
            $d = body(); $email = strtolower(str($d['email'] ?? '', 190));
            rate_limit('forgot:' . client_ip(), 6, 3600); rate_limit('forgotu:' . substr(hash('sha256', $email), 0, 40), 3, 3600);
            $u = $email !== '' ? q('SELECT id,name,email FROM users WHERE email = ?', [$email])->fetch() : false;
            if ($u && mail_configured()) {
                $tok = bin2hex(random_bytes(24));
                q('INSERT INTO password_resets (user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)', [$u['id'], hash('sha256', $tok), date('Y-m-d H:i:s', time() + 3600), now()]);
                $url = app_base_url() . '/index.html#/reset/' . $tok;
                send_mail($u['email'], 'Reset your password', email_html('Reset your password', '<p>Hello ' . htmlspecialchars($u['name'], ENT_QUOTES, 'UTF-8') . ',</p><p>We received a request to reset your password. This link works for one hour and can be used once. If you did not ask for it, ignore this e-mail - your password stays the same.</p>', ['Choose a new password', $url]));
            }
            json_out(['ok' => true, 'mail_configured' => mail_configured()]);
        }
        if ($b === 'reset' && $m === 'POST') {
            ensure_schema(); rate_limit('reset:' . client_ip(), 10, 3600);
            $d = body(); $pw = (string)($d['password'] ?? '');
            if (strlen($pw) < 8) fail('Password must be at least 8 characters');
            $r = q('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0', [hash('sha256', (string)($d['token'] ?? ''))])->fetch();
            if (!$r || $r['expires_at'] < now()) fail('This reset link is invalid or has expired. Request a new one.');
            q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [password_hash($pw, PASSWORD_DEFAULT), $r['user_id']]);
            q('UPDATE password_resets SET used = 1 WHERE user_id = ?', [$r['user_id']]);
            $ru = q('SELECT name FROM users WHERE id = ?', [$r['user_id']])->fetch();
            audit(['name' => $ru['name'] ?? ''], 'password.reset', '#' . $r['user_id']);
            json_out(['ok' => true]);
        }
        if ($b === '2fa' && $m === 'POST') {
            $u = require_auth(); $row = q('SELECT * FROM users WHERE id = ?', [$u['id']])->fetch(); $d = body();
            if ($c === 'setup') {
                if ((int)$row['totp_enabled'] === 1) fail('Two-step sign-in is already on', 409);
                $secret = totp_new_secret();
                q('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [$secret, $u['id']]);
                $issuer = (string)(get_setting('company_name') ?: 'Infraura');
                json_out(['secret' => $secret, 'uri' => totp_uri($secret, $u['email'], $issuer)]);
            }
            if ($c === 'enable') {
                if (!$row['totp_secret'] || (int)$row['totp_enabled'] === 1) fail('Start the set-up first', 409);
                $ctr = totp_verify((string)$row['totp_secret'], (string)($d['code'] ?? ''), 0);
                if (!$ctr) fail('That code did not match. Check the time on your phone and try the latest code.');
                [$plain, $json] = make_recovery_codes();
                q('UPDATE users SET totp_enabled = 1, totp_last = ?, recovery_codes = ? WHERE id = ?', [$ctr, $json, $u['id']]);
                audit($u, '2fa.enable', $u['email']);
                json_out(['ok' => true, 'recovery_codes' => $plain]);
            }
            if ($c === 'disable') {
                if (!password_verify((string)($d['password'] ?? ''), $row['password_hash'])) fail('Password is wrong');
                q('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last = 0 WHERE id = ?', [$u['id']]);
                audit($u, '2fa.disable', $u['email']);
                json_out(['ok' => true]);
            }
        }
        fail('Not found', 404);
    }

    $user = require_auth();
    if (!empty($_SESSION['must_change'])) fail('Please set a new password first', 428);
    $GLOBALS['CURRENT_USER'] = $user;
    ensure_schema();

    switch ($a) {
        case 'tick': // background housekeeping: the browser pings this after sign-in so jobs run without any cron setup
            if ($m !== 'POST') break;
            session_write_close();
            $ran = maybe_run_jobs();
            json_out(['ran' => $ran !== null]);

        case 'setup': // "finish setting up" checklist (admin)
            require_admin();
            if ($m === 'POST' && $b === 'dismiss') { set_setting('setup_dismissed', '1'); json_out(['ok' => true]); }
            if ($m === 'POST' && $b === 'rates-reviewed') { set_setting('rates_reviewed', '1'); json_out(['ok' => true]); }
            if ($m === 'GET') json_out(setup_checklist());
            break;

        case 'bootstrap': // everything the UI needs after login
            json_out([
                'user' => $user,
                'settings' => all_settings($user['role'] === 'admin'),
                'clients' => array_reverse(q('SELECT id,name,contact_person,phone,email,address,gstin FROM clients ORDER BY id DESC LIMIT 300')->fetchAll()),   // the most recent; the editor searches the rest on demand
                'rates' => rates_list(),
                'templates' => templates_list(),
                'divisions' => DIVISIONS,
            ]);

        case 'dashboard':
            json_out(dashboard());

        case 'settings':
            if ($m === 'GET') json_out(all_settings($user['role'] === 'admin'));
            if ($m === 'PUT') {
                require_admin();
                $d = body();
                $allowed = array_diff(array_keys(all_settings_raw()), ['cron_key', 'cron_last_run', 'schema_v', 'auto_jobs_at']);
                foreach ($d as $k => $v) {
                    if (!in_array($k, $allowed, true)) continue;
                    $v = trim((string)$v);
                    if ($k === 'smtp_pass' && $v === '********') continue;   // masked placeholder echoed back by the form: keep the stored password
                    if ($k === 'smtp_port' && (!ctype_digit($v) || (int)$v < 1 || (int)$v > 65535)) fail('SMTP port must be a number between 1 and 65535');
                    if ($k === 'smtp_enc' && !in_array($v, ['ssl', 'tls', 'none'], true)) fail('Encryption must be ssl, tls or none');
                    if ($k === 'mail_from' && $v !== '' && !filter_var($v, FILTER_VALIDATE_EMAIL)) fail('From address must be a valid e-mail address');
                    if (in_array($k, ['client_reminders', 'oauth_enabled', 'auto_jobs', 'notify_events', 'confirm_client', 'auto_project', 'overdue_reminders', 'setup_dismissed', 'rates_reviewed'], true) && !in_array($v, ['0', '1'], true)) fail('Invalid on/off setting');
                    if ($k === 'backup_keep' && (!ctype_digit($v) || (int)$v < 1 || (int)$v > 90)) fail('Keep between 1 and 90 backups');
                    if ($k === 'validity_days' && (!ctype_digit($v) || (int)$v < 1 || (int)$v > 365)) fail('Validity must be a whole number of days between 1 and 365');
                    if (($k === 'min_margin' || strpos($k, 'gst_') === 0) && (!is_numeric($v) || (float)$v < 0 || (float)$v > 100)) fail('Percentages must be numbers between 0 and 100');
                    if ($k === 'quote_prefix' && !preg_match('/^[A-Za-z0-9-]{1,10}$/', $v)) fail('Quote prefix: 1-10 letters, digits or hyphens');
                    if (in_array($k, ['company_email'], true) && $v !== '' && !filter_var($v, FILTER_VALIDATE_EMAIL)) fail('Enter a valid company email');
                    if ($k === 'company_logo' && strlen($v) > 600000) fail('Logo too large (max ~400 KB)');
                    set_setting($k, $v);
                }
                audit($user, 'settings.save', 'Company / defaults updated');
                json_out(all_settings($user['role'] === 'admin'));
            }
            break;

        case 'users':
            require_admin();
            if ($m === 'GET' && $b === null) json_out(q('SELECT id,name,email,role,created_at,totp_enabled,must_change_password FROM users ORDER BY id')->fetchAll());
            if ($m === 'POST' && $b === null) {
                $d = body();
                $email = strtolower(str($d['email'] ?? '', 190));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Valid email required');
                if (strlen((string)($d['password'] ?? '')) < 8) fail('Password must be at least 8 characters');
                if (q('SELECT 1 FROM users WHERE email = ?', [$email])->fetch()) fail('Email already exists');
                $role = ($d['role'] ?? '') === 'admin' ? 'admin' : 'staff';
                q('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)',
                    [str($d['name'] ?? '', 120) ?: 'User', $email, password_hash((string)$d['password'], PASSWORD_DEFAULT), $role, now()]);
                audit($user, 'user.add', $email . ' (' . $role . ')');
                json_out(['ok' => true], 201);
            }
            $uid = $b !== null && ctype_digit($b) ? (int)$b : 0;
            $target = $uid ? q('SELECT * FROM users WHERE id = ?', [$uid])->fetch() : null;
            if ($b !== null && !$target) fail('User not found', 404);
            if ($m === 'PUT' && $target) {
                $d = body(); $role = ($d['role'] ?? $target['role']) === 'admin' ? 'admin' : 'staff';
                if ($target['role'] === 'admin' && $role !== 'admin' && admin_count() <= 1) fail('There must always be at least one admin', 409);
                q('UPDATE users SET name = ?, role = ? WHERE id = ?', [str($d['name'] ?? $target['name'], 120) ?: $target['name'], $role, $uid]);
                audit($user, 'user.update', $target['email'] . ' -> ' . $role);
                json_out(['ok' => true]);
            }
            if ($m === 'POST' && $target && $c === 'reset-password') {
                $d = body(); $tmp = temp_password();
                q('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [password_hash($tmp, PASSWORD_DEFAULT), $uid]);
                $emailed = false;
                if (!empty($d['send_email']) && mail_configured()) { [$emailed] = send_mail($target['email'], 'Your password was reset', email_html('Your password was reset', '<p>An administrator reset your password. Your temporary password is:</p><p style="font-size:20px;font-weight:700;letter-spacing:1px">' . htmlspecialchars($tmp, ENT_QUOTES, 'UTF-8') . '</p><p>You will be asked to choose a new password when you sign in.</p>', ['Sign in', app_base_url() . '/index.html'])); }
                audit($user, 'user.reset_password', $target['email']);
                json_out(['ok' => true, 'temp_password' => $tmp, 'emailed' => $emailed]);
            }
            if ($m === 'POST' && $target && $c === 'disable-2fa') {
                q('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last = 0 WHERE id = ?', [$uid]);
                audit($user, 'user.disable_2fa', $target['email']);
                json_out(['ok' => true]);
            }
            if ($m === 'DELETE' && $target) {
                if ($uid === (int)$user['id']) fail('You cannot delete yourself');
                if ($target['role'] === 'admin' && admin_count() <= 1) fail('There must always be at least one admin', 409);
                audit($user, 'user.delete', $target['email']);
                q('DELETE FROM users WHERE id = ?', [$uid]);
                json_out(['ok' => true]);
            }
            break;

        case 'mail':
            require_admin();
            if ($m === 'POST' && $b === 'test') {
                $to = strtolower(str(body()['to'] ?? '', 190));
                if (!filter_var($to, FILTER_VALIDATE_EMAIL)) fail('Enter the address to send the test to');
                rate_limit('mailtest:' . $user['id'], 10, 3600);
                [$ok, $err] = send_mail($to, 'Test e-mail from ' . (get_setting('company_name') ?: 'Infraura'), email_html('E-mail is working', '<p>This is a test message from your quotation app. If you can read it, quotes, reminders and password resets can be e-mailed.</p>'));
                audit($user, 'mail.test', $to . ($ok ? ' ok' : ' failed'));
                json_out(['ok' => $ok, 'error' => $err]);
            }
            if ($m === 'GET' && $b === 'log') json_out(q('SELECT recipient,subject,status,error,created_at FROM email_log ORDER BY id DESC LIMIT 40')->fetchAll());
            break;

        case 'clients':
            clients_route($m, $b, $c, $user);
            break;

        case 'rates':
            rates_route($m, $b);
            break;

        case 'templates':
            templates_route($m, $b);
            break;

        case 'tokens': // API tokens for AI assistants (MCP) - admin only; the plain token is shown exactly once
            require_admin();
            if ($m === 'GET') {
                // OAuth connections issue a new short-lived token every hour: show each connection once (its newest token)
                $rows = q('SELECT t.id,t.name,t.prefix,t.scope,t.hide_costs,t.last_used_at,t.expires_at,t.revoked,t.created_at,t.oauth_client,t.grant_id,(SELECT u.name FROM users u WHERE u.id = t.user_id) AS owner,
                    (SELECT COUNT(*) FROM oauth_refresh r WHERE r.grant_id = t.grant_id AND r.revoked = 0 AND r.expires_at > ?) AS refresh_ok FROM api_tokens t
                    WHERE t.oauth_client IS NULL OR t.id IN (SELECT m.mid FROM (SELECT MAX(id) AS mid FROM api_tokens WHERE oauth_client IS NOT NULL GROUP BY grant_id) m) ORDER BY t.id DESC LIMIT 100', [time()])->fetchAll();
                foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['revoked'] = (int)$r['revoked']; $r['hide_costs'] = (int)$r['hide_costs']; $r['oauth'] = $r['oauth_client'] !== null; $r['refresh_ok'] = (int)$r['refresh_ok']; $r['expired'] = $r['oauth'] ? (!$r['revoked'] && $r['refresh_ok'] === 0) : ($r['expires_at'] && $r['expires_at'] < now()); unset($r['grant_id']); }
                json_out($rows);
            }
            if ($m === 'POST') {
                $d = body();
                $name = str($d['name'] ?? '', 120);
                if ($name === '') fail('Give the token a name (e.g. "Claude - sales team")');
                $scope = ($d['scope'] ?? '') === 'write' ? 'write' : 'read';
                $days = (int)($d['expires_days'] ?? 0);
                $plain = 'qbmcp_' . bin2hex(random_bytes(24));
                q('INSERT INTO api_tokens (name,token_hash,prefix,scope,hide_costs,user_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
                    [$name, hash('sha256', $plain), substr($plain, 0, 12), $scope, empty($d['show_costs']) ? 1 : 0, $user['id'], $days > 0 ? date('Y-m-d H:i:s', strtotime("+$days days")) : null, now()]);
                $tokenId = (int)db()->lastInsertId();   // read BEFORE audit() inserts its own row
                audit($user, 'token.create', $name . ' (' . $scope . ')');
                json_out(['id' => $tokenId, 'token' => $plain, 'scope' => $scope], 201);
            }
            if ($m === 'DELETE' && $b !== null) {
                $tr = q('SELECT grant_id FROM api_tokens WHERE id = ?', [(int)$b])->fetch();
                if ($tr && $tr['grant_id']) revoke_grant($tr['grant_id']);          // OAuth connection: closes the refresh token too
                q('UPDATE api_tokens SET revoked = 1 WHERE id = ?', [(int)$b]);
                audit($user, 'token.revoke', '#' . (int)$b);
                json_out(['ok' => true]);
            }
            break;

        case 'system': // health, backups and cron details for the admin Settings card
            require_admin();
            if ($m === 'GET' && $b === null) {
                $files = backup_files();
                $cronPath = __DIR__ . '/cron.php';
                json_out(['schema' => (int)get_setting('schema_v'), 'php' => PHP_VERSION, 'driver' => config()['driver'] ?? 'mysql', 'mail_configured' => mail_configured(), 'cron_last_run' => get_setting('cron_last_run') ?: null,
                    'cron_key' => get_setting('cron_key'), 'cron_cmd' => '/usr/bin/php ' . $cronPath, 'cron_url' => app_base_url() . '/api/cron.php?key=' . get_setting('cron_key'), 'health_url' => app_base_url() . '/api/health.php',
                    'backups' => $files, 'errors_24h' => count(app_errors_since(86400)), 'recent_errors' => array_slice(array_reverse(app_errors_since(86400)), 0, 8), 'disk_free_mb' => (int)(@disk_free_space(__DIR__) / 1048576), 'users' => (int)q('SELECT COUNT(*) AS n FROM users')->fetch()['n'],
                    'db_quotes' => (int)q('SELECT COUNT(*) AS n FROM quotes')->fetch()['n']]);
            }
            if ($m === 'POST' && $b === 'backup') { [$n, $bytes] = backup_to_disk(); audit($user, 'backup.manual', $n); json_out(['file' => $n, 'bytes' => $bytes]); }
            if ($m === 'GET' && $b === 'backup' && $c !== null && preg_match('/^backup-\d{8}-\d{6}(-[a-f0-9]{16})?\.json\.gz$/', $c) && is_file(data_dir() . '/backups/' . $c)) {
                header('Content-Type: application/gzip'); header('Content-Disposition: attachment; filename="' . $c . '"'); readfile(data_dir() . '/backups/' . $c); exit;
            }
            break;

        case 'reports':
            json_out(reports());

        case 'audit':
            require_admin();
            json_out(q('SELECT user_name,action,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 150')->fetchAll());

        case 'backup':
            require_admin();
            backup_download();

        case 'projects':
            projects_route($m, array_slice($GLOBALS['parts'], 1), $user);
            break;

        case 'quotes':
            quotes_route($m, $b, $c, $user);
            break;
    }
    fail('Not found', 404);
}

function clients_route(string $m, ?string $b, ?string $c, array $user): void
{
    $sel = 'SELECT c.*, (SELECT COUNT(*) FROM quotes x WHERE x.client_id = c.id AND x.is_latest = 1) AS quote_count FROM clients c';
    if ($m === 'GET' && $b === null) {
        $w = ''; $p = [];
        if (!empty($_GET['q'])) {
            $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim((string)$_GET['q'])) . '%';
            $w = ' WHERE c.name LIKE ? OR c.contact_person LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.gstin LIKE ?'; $p = [$like, $like, $like, $like, $like];
        }
        if (isset($_GET['per'])) {   // paginated: {rows,total}
            $per = max(1, min(200, (int)$_GET['per'])); $page = max(1, (int)($_GET['page'] ?? 1));
            $total = (int)q('SELECT COUNT(*) AS n FROM clients c' . $w, $p)->fetch()['n'];
            $order = !empty($_GET['recent']) ? 'c.id DESC' : 'c.name';
            json_out(['rows' => q($sel . $w . " ORDER BY $order LIMIT " . $per . ' OFFSET ' . (($page - 1) * $per), $p)->fetchAll(), 'total' => $total, 'page' => $page, 'per' => $per]);
        }
        json_out(q($sel . $w . ' ORDER BY c.name LIMIT 5000', $p)->fetchAll());
    }
    if ($m === 'POST' && $b === null) {
        $f = client_fields(body());
        q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', array_merge($f, [now()]));
        json_out(['id' => (int)db()->lastInsertId()], 201);
    }
    $cid = $b !== null && ctype_digit($b) ? (int)$b : 0;
    $cl = $cid ? q('SELECT * FROM clients WHERE id = ?', [$cid])->fetch() : null;
    if ($b !== null && !$cl) fail('Client not found', 404);
    if ($m === 'PUT' && $cl) {
        $f = client_fields(body());
        q('UPDATE clients SET name=?,contact_person=?,phone=?,email=?,address=?,gstin=? WHERE id=?', array_merge($f, [$cid]));
        json_out(['ok' => true]);
    }
    if ($m === 'GET' && $cl && $c === 'export') {          // privacy: everything held about this client, as a download
        require_admin();
        $quotes = q('SELECT * FROM quotes WHERE client_id = ? ORDER BY id', [$cid])->fetchAll(); $nos = array_values(array_unique(array_column($quotes, 'quote_no')));
        $out = ['exported_at' => now(), 'client' => $cl, 'quotes' => array_map(fn($r) => quote_row_out($r, true), $quotes), 'events' => [], 'projects' => []];
        foreach ($nos as $no) {
            foreach (q('SELECT type,detail,actor,ip,created_at FROM quote_events WHERE quote_no = ? ORDER BY id', [$no])->fetchAll() as $ev) $out['events'][] = ['quote_no' => $no] + $ev;
            $pr = q('SELECT id FROM projects WHERE quote_no = ?', [$no])->fetch(); if ($pr) { $d = project_detail((int)$pr['id']); unset($d['quote']); $out['projects'][] = $d; }
        }
        audit($user, 'client.export', '#' . $cid . ' ' . $cl['name']);
        header('Content-Type: application/json; charset=utf-8'); header('Content-Disposition: attachment; filename="client-' . $cid . '-data.json"');
        echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR); exit;
    }
    if ($m === 'POST' && $cl && $c === 'anonymize') {      // privacy: erase personal data, keeping what tax law requires us to keep
        require_admin();
        if (empty(body()['confirm'])) fail('Confirmation required');
        $financial = q("SELECT 1 FROM quotes WHERE client_id = ? AND status = 'accepted' LIMIT 1", [$cid])->fetch() || q('SELECT 1 FROM projects WHERE client_id = ? LIMIT 1', [$cid])->fetch();
        db()->beginTransaction();
        $quotes = q('SELECT id, quote_no, status, client_json FROM quotes WHERE client_id = ?', [$cid])->fetchAll();
        foreach ($quotes as $qr) {
            $keep = $financial && ($qr['status'] === 'accepted' || q('SELECT 1 FROM projects WHERE quote_no = ?', [$qr['quote_no']])->fetch());
            $j = json_decode((string)$qr['client_json'], true) ?: [];
            if ($keep) $j = array_merge($j, ['phone' => '', 'email' => '', 'contact_person' => '']);          // invoices keep name / address / GSTIN
            else $j = ['name' => $financial ? ($j['name'] ?? 'Erased client') : 'Erased client #' . $cid, 'contact_person' => '', 'phone' => '', 'email' => '', 'address' => '', 'gstin' => ''];
            q('UPDATE quotes SET client_json = ? WHERE id = ?', [json_encode($j, JSON_UNESCAPED_UNICODE), $qr['id']]);
            if (!$keep) { q('DELETE FROM quote_events WHERE quote_no = ?', [$qr['quote_no']]); q('DELETE FROM quote_shares WHERE quote_no = ?', [$qr['quote_no']]); }
        }
        if ($financial) q("UPDATE clients SET contact_person = '', phone = '', email = '', anonymized = 1 WHERE id = ?", [$cid]);
        else q("UPDATE clients SET name = ?, contact_person = '', phone = '', email = '', address = '', gstin = '', anonymized = 1 WHERE id = ?", ['Erased client #' . $cid, $cid]);
        db()->commit();
        audit($user, 'client.anonymize', '#' . $cid . ($financial ? ' (partial - tax records retained)' : ' (full)'));
        json_out(['ok' => true, 'mode' => $financial ? 'partial' : 'full', 'note' => $financial ? 'Phone, e-mail and contact person were erased. The name, address and GSTIN stay on accepted quotes, projects and invoices because tax law requires invoices to be kept.' : 'All personal details were erased.']);
    }
    if ($m === 'DELETE' && $cl) {
        $n = (int)q('SELECT COUNT(*) AS n FROM quotes WHERE client_id = ?', [$cid])->fetch()['n'];
        if ($n > 0) fail("This client has $n quote(s) and cannot be deleted");
        if (q('SELECT 1 FROM projects WHERE client_id = ?', [$cid])->fetch()) fail('This client has a project and cannot be deleted');
        q('DELETE FROM clients WHERE id = ?', [$cid]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

function rates_route(string $m, ?string $b): void
{
    if ($m !== 'GET') require_admin();
    if ($m === 'GET') json_out(rates_list(isset($_GET['division']) ? (string)$_GET['division'] : null));
    if ($m === 'POST' && $b === 'import') {
        $d = body();
        $items = $d['items'] ?? [];
        if (!is_array($items) || !$items) fail('No rows to import');
        if (count($items) > 2000) fail('Too many rows (max 2000)');
        $rows = [];
        foreach ($items as $i => $it) {   // validate everything first so a bad row cannot cause a half-finished import
            if (!is_array($it)) continue;
            try { $rows[] = rate_fields($it); } catch (Throwable $e) { throw $e; }
        }
        $have = [];
        foreach (q('SELECT division, name, unit FROM rate_items')->fetchAll() as $r) $have[strtolower($r['division'] . '|' . $r['name'] . '|' . $r['unit'])] = true;
        $n = 0; $skipped = 0;
        db()->beginTransaction();
        foreach ($rows as $f) {
            $key = strtolower($f[0] . '|' . $f[2] . '|' . $f[3]);
            if (isset($have[$key])) { $skipped++; continue; }
            $have[$key] = true;
            q('INSERT INTO rate_items (division,category,name,unit,rate,description,active,cost,sort) VALUES (?,?,?,?,?,?,?,?,9999)', $f);
            $n++;
        }
        db()->commit();
        audit($GLOBALS['CURRENT_USER'] ?? [], 'rates.import', "$n added, $skipped duplicates skipped");
        json_out(['imported' => $n, 'skipped' => $skipped], 201);
    }
    if ($m === 'POST') {
        $f = rate_fields(body());
        q('INSERT INTO rate_items (division,category,name,unit,rate,description,active,cost,sort) VALUES (?,?,?,?,?,?,?,?,9999)', $f);
        json_out(['id' => (int)db()->lastInsertId()], 201);
    }
    if ($m === 'PUT' && $b !== null) {
        $f = rate_fields(body());
        q('UPDATE rate_items SET division=?,category=?,name=?,unit=?,rate=?,description=?,active=?,cost=? WHERE id=?', array_merge($f, [(int)$b]));
        json_out(['ok' => true]);
    }
    if ($m === 'DELETE' && $b !== null) {
        q('DELETE FROM rate_items WHERE id = ?', [(int)$b]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

function templates_route(string $m, ?string $b): void
{
    if ($m === 'GET') json_out(templates_list());
    if ($m === 'POST') {
        $d = body();
        $div = (string)($d['division'] ?? '');
        if (!isset(DIVISIONS[$div])) fail('Invalid division');
        $name = str($d['name'] ?? '', 190);
        if ($name === '') fail('Template name is required');
        $x = is_array($d['data'] ?? null) ? $d['data'] : [];
        $data = ['sections' => clean_sections($x['sections'] ?? []), 'terms' => array_values(array_filter(array_map(fn($t) => is_string($t) ? mb_substr(trim($t), 0, 600) : '', is_array($x['terms'] ?? null) ? $x['terms'] : []), 'strlen')),
            'scope' => str($x['scope'] ?? '', 3000), 'notes' => str($x['notes'] ?? '', 3000)];
        q('INSERT INTO quote_templates (name,division,data,created_at) VALUES (?,?,?,?)', [$name, $div, json_encode($data, JSON_UNESCAPED_UNICODE), now()]);
        json_out(['id' => (int)db()->lastInsertId()], 201);
    }
    if ($m === 'DELETE' && $b !== null) {
        q('DELETE FROM quote_templates WHERE id = ?', [(int)$b]);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

/** E-mail a quote link to the client, mark it sent and log it. Fails (readable message) if the mail cannot be sent. */
function send_quote_email(array $row, array $user, string $to, string $msg): void
{
    $id = (int)$row['id']; $cl = json_decode((string)$row['client_json'], true) ?: [];
    $tok = ensure_share_token($row, $user);
    $co = (string)(get_setting('company_name') ?: 'Infraura');
    $msg = trim($msg);
    $bodyHtml = '<p>Dear ' . htmlspecialchars($cl['contact_person'] ?: ($cl['name'] ?? ''), ENT_QUOTES, 'UTF-8') . ',</p>' . ($msg !== '' ? '<p>' . nl2br(htmlspecialchars($msg, ENT_QUOTES, 'UTF-8')) . '</p>' : '<p>Please find your quotation ' . htmlspecialchars($row['quote_no'], ENT_QUOTES, 'UTF-8') . ($row['title'] ? ' for <b>' . htmlspecialchars($row['title'], ENT_QUOTES, 'UTF-8') . '</b>' : '') . '.</p>')
        . '<p>You can view it, choose an option and accept it online. It is valid until ' . htmlspecialchars(date('d-m-Y', strtotime((string)$row['valid_until'])), ENT_QUOTES, 'UTF-8') . '.</p>';
    [$sent, $err] = send_mail($to, 'Quotation ' . $row['quote_no'] . ' from ' . $co, email_html('Your quotation ' . $row['quote_no'], $bodyHtml, ['View quotation', app_base_url() . '/view.html?t=' . $tok]));
    if (!$sent) fail('The e-mail could not be sent: ' . $err);
    if ($row['status'] === 'draft') q('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?', ['sent', now(), $id]);
    log_event($row['quote_no'], (int)$row['rev'], 'emailed', ['to' => $to, 'by' => $user['name']], $user['name']);
    audit($user, 'quote.email', $row['quote_no'] . ' -> ' . $to);
}

function quotes_route(string $m, ?string $b, ?string $c, array $user): void
{
    if ($m === 'POST' && $b === 'quick-roofing') {   // one step: size + material in, priced draft out; optionally sent to the client straight away
        $d = body();
        $out = roofing_quote_create($d, $user);
        if (!empty($d['send'])) {
            $row = q('SELECT * FROM quotes WHERE id = ?', [$out['quote_id']])->fetch();
            $cl = json_decode((string)$row['client_json'], true) ?: [];
            if (!filter_var($cl['email'] ?? '', FILTER_VALIDATE_EMAIL)) { $out['sent'] = false; $out['send_note'] = 'No client e-mail on file, so the draft was not sent.'; }
            elseif (!mail_configured()) { $out['sent'] = false; $out['send_note'] = 'E-mail is not set up yet, so the draft was not sent.'; }
            else {
                $GLOBALS['FAIL_THROWS'] = true;
                try { send_quote_email($row, $user, strtolower($cl['email']), ''); $out['sent'] = true; }
                catch (ApiFailure $e) { $out['sent'] = false; $out['send_note'] = $e->getMessage(); }
                $GLOBALS['FAIL_THROWS'] = false;
            }
        }
        audit($user, 'quote.quick', $out['quote_no'] . (!empty($out['sent']) ? ' (sent)' : ''));
        json_out($out, 201);
    }
    if ($m === 'GET' && $b === null) {
        $where = [];
        $p = [];
        if (empty($_GET['all'])) $where[] = 'is_latest = 1';
        if (!empty($_GET['status']) && in_array($_GET['status'], STATUSES, true)) { $where[] = 'status = ?'; $p[] = $_GET['status']; }
        if (!empty($_GET['division']) && isset(DIVISIONS[$_GET['division']])) { $where[] = 'division = ?'; $p[] = $_GET['division']; }
        if (!empty($_GET['client_id'])) { $where[] = 'client_id = ?'; $p[] = (int)$_GET['client_id']; }
        if (!empty($_GET['q'])) {
            $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim((string)$_GET['q'])) . '%';
            $where[] = '(quote_no LIKE ? OR title LIKE ? OR client_json LIKE ?)';
            array_push($p, $like, $like, $like);
        }
        $cols = 'id,quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,subtotal,discount,tax,round_off,total,created_at,updated_at';
        $wh = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        if (isset($_GET['per'])) {   // paginated: {rows,total}
            $per = max(1, min(200, (int)$_GET['per'])); $page = max(1, (int)($_GET['page'] ?? 1));
            $total = (int)q('SELECT COUNT(*) AS n FROM quotes' . $wh, $p)->fetch()['n'];
            json_out(['rows' => array_map(fn($r) => quote_row_out($r, false), q("SELECT $cols FROM quotes" . $wh . ' ORDER BY id DESC LIMIT ' . $per . ' OFFSET ' . (($page - 1) * $per), $p)->fetchAll()), 'total' => $total, 'page' => $page, 'per' => $per]);
        }
        json_out(array_map(fn($r) => quote_row_out($r, false), q("SELECT $cols FROM quotes" . $wh . ' ORDER BY id DESC LIMIT 500', $p)->fetchAll()));
    }

    if ($m === 'POST' && $b === null) {
        $r = create_quote($user, body());
        json_out(['id' => $r['id'], 'quote_no' => $r['quote_no']], 201);
    }

    if ($b === null || !ctype_digit($b)) fail('Not found', 404);
    $id = (int)$b;
    $row = q('SELECT * FROM quotes WHERE id = ?', [$id])->fetch();
    if (!$row) fail('Quote not found', 404);

    if ($m === 'GET' && $c === null) {
        $revs = q('SELECT id,rev,status,total,updated_at FROM quotes WHERE quote_no = ? ORDER BY rev DESC', [$row['quote_no']])->fetchAll();
        $share = q('SELECT token FROM quote_shares WHERE quote_no = ?', [$row['quote_no']])->fetch();
        $ev = q('SELECT type,detail,actor,created_at,rev FROM quote_events WHERE quote_no = ? ORDER BY id DESC LIMIT 30', [$row['quote_no']])->fetchAll();
        foreach ($ev as &$e) { $d = json_decode((string)$e['detail'], true) ?: []; $e['has_signature'] = !empty($d['signature']); unset($d['signature']); $e['detail'] = $d ?: new stdClass(); }
        json_out(['quote' => quote_row_out($row, true), 'revisions' => $revs, 'share' => $share ? $share['token'] : null, 'events' => $ev,
            'project' => ($pr = q('SELECT id FROM projects WHERE quote_no = ?', [$row['quote_no']])->fetch()) ? (int)$pr['id'] : null]);
    }

    if ($m === 'PUT' && $c === null) {
        if ($row['status'] === 'superseded') fail('This revision is superseded and read-only. Open the latest revision.', 409);
        if ($row['status'] === 'accepted') fail('This quotation has been accepted and is locked. Create a new revision to change it.', 409);
        $in = body();
        // optimistic lock: refuse to overwrite changes someone else (or the client) made since this screen was loaded
        if (isset($in['updated_at']) && (string)$in['updated_at'] !== (string)$row['updated_at']) fail('This quotation was changed by someone else since you opened it. Reload the page to see the latest version (copy any unsaved notes first).', 409);
        [$division, $title, $data, $client, $date, $valid, $cid] = clean_quote_input($in, $row['division']);
        [$cid, $client] = resolve_client($cid, $client);
        [$sub, $disc, $tax, $round, $total] = compute_totals($data);
        $ts = now();
        $upd = q('UPDATE quotes SET client_id=?,client_json=?,title=?,quote_date=?,valid_until=?,data=?,subtotal=?,discount=?,tax=?,round_off=?,total=?,updated_at=? WHERE id=? AND status <> ? AND status <> ?',
            [$cid, json_encode($client, JSON_UNESCAPED_UNICODE), $title, $date, $valid, json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, $ts, $id, 'accepted', 'superseded']);
        if ($upd->rowCount() !== 1) fail('This quotation can no longer be edited (it was accepted or revised a moment ago). Reload the page.', 409);
        json_out(['ok' => true, 'total' => $total, 'client_id' => $cid, 'updated_at' => $ts]);
    }

    if ($m === 'DELETE' && $c === 'share') {
        q('DELETE FROM quote_shares WHERE quote_no = ?', [$row['quote_no']]);
        audit($user, 'quote.unshare', $row['quote_no']);
        json_out(['ok' => true]);
    }

    if ($m === 'POST' && $c === 'share') {
        if (!(int)$row['is_latest']) fail('Only the latest revision can be shared', 409);
        $ex = q('SELECT token FROM quote_shares WHERE quote_no = ?', [$row['quote_no']])->fetch();
        $tok = $ex ? $ex['token'] : bin2hex(random_bytes(16));
        if (!$ex) q('INSERT INTO quote_shares (quote_no,token,created_at) VALUES (?,?,?)', [$row['quote_no'], $tok, now()]);
        if ($row['status'] === 'draft') q('UPDATE quotes SET status=?, updated_at=? WHERE id=?', ['sent', now(), $id]);
        log_event($row['quote_no'], (int)$row['rev'], 'shared', ['by' => $user['name']], $user['name']);
        $fresh = q('SELECT updated_at FROM quotes WHERE id = ?', [$id])->fetch();
        json_out(['token' => $tok, 'updated_at' => $fresh['updated_at']]);
    }

    if ($m === 'POST' && $c === 'email') {
        if (!(int)$row['is_latest']) fail('Only the latest revision can be e-mailed', 409);
        if (!mail_configured()) fail('E-mail is not set up yet. Add your mail account under Settings > E-mail.');
        rate_limit('qmail:' . $user['id'], 40, 3600);
        $in = body(); $cl = json_decode((string)$row['client_json'], true) ?: [];
        $to = strtolower(str($in['to'] ?? ($cl['email'] ?? ''), 190));
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) fail('Enter a valid e-mail address for the client');
        send_quote_email($row, $user, $to, str($in['message'] ?? '', 2000));
        $fresh = q('SELECT updated_at FROM quotes WHERE id = ?', [$id])->fetch();
        json_out(['ok' => true, 'to' => $to, 'updated_at' => $fresh['updated_at']]);
    }

    if ($m === 'POST' && $c === 'status') {
        $s = (string)(body()['status'] ?? '');
        if (!in_array($s, ['draft', 'sent', 'accepted', 'rejected'], true)) fail('Invalid status');
        if ($row['status'] === 'superseded') fail('Superseded revisions cannot change status', 409);
        if (!(int)$row['is_latest']) fail('Only the latest revision can change status', 409);
        if ($row['status'] === 'accepted' && $s !== 'accepted') {
            if (($user['role'] ?? '') !== 'admin') fail('Only an admin can re-open an accepted quotation', 403);
            if (q('SELECT 1 FROM projects WHERE quote_no = ?', [$row['quote_no']])->fetch()) fail('A project exists for this quotation. Delete the project first, or use variation orders for changes.', 409);
        }
        q('UPDATE quotes SET status=?, updated_at=? WHERE id=?', [$s, now(), $id]);
        audit($user, 'quote.status', $row['quote_no'] . ' -> ' . $s);
        json_out(['ok' => true]);
    }

    if ($m === 'POST' && $c === 'revise') {
        if (!(int)$row['is_latest']) fail('Only the latest revision can be revised');
        if (q('SELECT 1 FROM projects WHERE quote_no = ?', [$row['quote_no']])->fetch()) fail('A project already exists for this quotation. Record changes as variation orders in the project instead.', 409);
        $newRev = (int)$row['rev'] + 1;
        db()->beginTransaction();
        q('UPDATE quotes SET is_latest = 0, status = ?, updated_at = ? WHERE id = ?', ['superseded', now(), $id]);
        q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$row['quote_no'], $newRev, 1, $row['division'], $row['client_id'], $row['client_json'], $row['title'], 'draft', date('Y-m-d'),
                date('Y-m-d', strtotime('+' . (int)(get_setting('validity_days') ?: 15) . ' days')), $row['data'], $row['subtotal'], $row['discount'], $row['tax'], $row['round_off'], $row['total'], $user['id'], now(), now()]);
        $newId = (int)db()->lastInsertId();
        db()->commit();
        audit($user, 'quote.revise', $row['quote_no'] . ' rev ' . $newRev);
        json_out(['id' => $newId, 'rev' => $newRev], 201);
    }

    if ($m === 'POST' && $c === 'duplicate') {
        $today = date('Y-m-d');
        $newId = 0; $no = '';
        for ($try = 0; $try < 8 && !$newId; $try++) {
            $no = next_quote_no($row['division'], $today);
            try {
                q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    [$no, 0, 1, $row['division'], $row['client_id'], $row['client_json'], $row['title'], 'draft', $today,
                        date('Y-m-d', strtotime('+' . (int)(get_setting('validity_days') ?: 15) . ' days')), $row['data'], $row['subtotal'], $row['discount'], $row['tax'], $row['round_off'], $row['total'], $user['id'], now(), now()]);
                $newId = (int)db()->lastInsertId();
            } catch (PDOException $e) {
                if ($e->getCode() !== '23000') throw $e;
                usleep(random_int(5000, 60000));
            }
        }
        if (!$newId) fail('Could not allocate a quote number - please try again', 503);
        audit($user, 'quote.duplicate', $row['quote_no'] . ' -> ' . $no);
        json_out(['id' => $newId, 'quote_no' => $no], 201);
    }

    if ($m === 'DELETE' && $c === null) {
        // Delete the whole quote family (all revisions) only when it is still a draft.
        if ($row['status'] !== 'draft' && !(int)$row['is_latest']) fail('Open the latest revision to delete');
        if ($row['status'] !== 'draft') fail('Only draft quotes can be deleted');
        q('DELETE FROM quotes WHERE quote_no = ?', [$row['quote_no']]);
        q('DELETE FROM quote_shares WHERE quote_no = ?', [$row['quote_no']]);
        q('DELETE FROM quote_events WHERE quote_no = ?', [$row['quote_no']]);
        audit($user, 'quote.delete', $row['quote_no']);
        json_out(['ok' => true]);
    }
    fail('Not found', 404);
}

function backup_download(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Disposition: attachment; filename="infraura-backup-' . date('Y-m-d') . '.json"');
    echo json_encode(backup_data(), JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}


/** What is left to do before the app is fully set up. Each item: key, label, done, hint, link. */
function setup_checklist(): array
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $local = in_array($_SERVER['SERVER_NAME'] ?? '', ['localhost', '127.0.0.1'], true);
    $sent = q("SELECT 1 FROM email_log WHERE status = 'sent' LIMIT 1")->fetch();
    $items = [
        ['key' => 'company', 'label' => 'Add company name, address and GSTIN', 'done' => trim((string)get_setting('company_name')) !== '' && trim((string)get_setting('company_address')) !== '' && trim((string)get_setting('company_gstin')) !== '', 'link' => '#/settings'],
        ['key' => 'rates', 'label' => 'Review the starter rates and costs', 'done' => get_setting('rates_reviewed') === '1', 'link' => '#/rates', 'action' => 'rates-reviewed'],
        ['key' => 'email', 'label' => 'Connect e-mail (so quotes, alerts and resets can be sent)', 'done' => mail_configured() && (bool)$sent, 'link' => '#/settings'],
        ['key' => '2fa', 'label' => 'Turn on two-step sign-in for admins', 'done' => (int)q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND totp_enabled = 1")->fetch()['n'] > 0, 'link' => '#/settings'],
        ['key' => 'https', 'label' => 'Use HTTPS (turn on SSL in hPanel)', 'done' => $https || $local, 'link' => null],
        ['key' => 'installer', 'label' => 'Delete install.php from the server', 'done' => !is_file(dirname(__DIR__) . '/install.php'), 'link' => null],
        ['key' => 'jobs', 'label' => 'Background jobs have run (backups, daily summary)', 'done' => get_setting('cron_last_run') !== null && get_setting('cron_last_run') !== '', 'link' => '#/settings'],
        ['key' => 'backup', 'label' => 'A backup exists', 'done' => count(backup_files()) > 0, 'link' => '#/settings'],
    ];
    $left = count(array_filter($items, fn($i) => !$i['done']));
    return ['items' => $items, 'left' => $left, 'dismissed' => get_setting('setup_dismissed') === '1' || $left === 0];
}
