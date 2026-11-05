<?php
declare(strict_types=1);
// Public (no login) endpoint used by view.html - a client opens their quotation via a private link,
// can choose an option, and accept (with e-signature) or decline it.
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/projects.php';
require __DIR__ . '/mail.php';
require __DIR__ . '/jobs.php';

$method = $_SERVER['REQUEST_METHOD'];
$act = (string)($_GET['r'] ?? '');
$tok = (string)($_GET['t'] ?? '');
if ($method !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'infraura') fail('Bad request', 403);
if (!preg_match('/^[a-f0-9]{32}$/', $tok)) fail('Invalid link', 404);

try {
    ensure_schema();
    $ip = client_ip();
    // generous for real people, hostile to scripts guessing tokens or hammering the form
    rate_limit('pub:' . $ip, 200, 600);
    if ($method === 'POST') rate_limit('pubpost:' . $ip, 15, 600);

    if ($act === 'variation' || $act === 'variation-respond') variation_public($act, $method, $tok, $ip);
    $share = q('SELECT quote_no FROM quote_shares WHERE token = ?', [$tok])->fetch();
    if (!$share) fail('This link is not valid or has been withdrawn', 404);
    $row = q('SELECT * FROM quotes WHERE quote_no = ? AND is_latest = 1', [$share['quote_no']])->fetch();
    if (!$row) fail('Quotation not found', 404);
    // links stop working 60 days after the quote's validity ends (accepted quotes stay viewable for the client's records)
    if ($row['status'] !== 'accepted' && $row['valid_until'] < date('Y-m-d', strtotime('-60 days'))) fail('This link has expired. Please ask us for a fresh quotation.', 410);
    // a draft (e.g. a revision being prepared) is never shown to the client
    $available = in_array($row['status'], ['sent', 'accepted', 'rejected'], true);

    if ($act === 'quote' && $method === 'GET') {
        $st = [];
        foreach (['company_name', 'company_tagline', 'company_address', 'company_phone', 'company_email', 'company_gstin', 'company_logo', 'signatory', 'bank_details'] as $k) $st[$k] = get_setting($k) ?? '';
        if (!$available) {
            json_out(['available' => false, 'quote' => ['quote_no' => $row['quote_no'], 'status' => 'draft', 'client' => new stdClass(), 'data' => ['sections' => [], 'options' => []]], 'settings' => $st, 'response' => null, 'expired' => false]);
        }
        // log at most one view per visitor IP per 30 minutes
        $recent = q("SELECT 1 FROM quote_events WHERE quote_no = ? AND type = 'view' AND ip = ? AND created_at >= ?", [$row['quote_no'], $ip, date('Y-m-d H:i:s', strtotime('-30 minutes'))])->fetch();
        if (!$recent) {
            $first = !q("SELECT 1 FROM quote_events WHERE quote_no = ? AND rev = ? AND type = 'view'", [$row['quote_no'], (int)$row['rev']])->fetch();
            q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'view', '{}', null, $ip, now()]);
            if ($first && $row['status'] === 'sent') notify_quote_event($row, 'viewed', []);
        }
        $data = json_decode((string)$row['data'], true) ?: [];
        unset($data['roofcalc'], $data['pmc'], $data['source']);
        $strip = function (array $secs): array {
            foreach ($secs as &$s) foreach ($s['items'] as &$it) unset($it['cost']);
            return $secs;
        };
        $data['sections'] = $strip($data['sections'] ?? []);
        foreach ($data['options'] ?? [] as $i => $o) $data['options'][$i]['sections'] = $strip($o['sections'] ?? []);
        $done = q("SELECT type,detail,created_at FROM quote_events WHERE quote_no = ? AND type IN ('accepted','rejected') ORDER BY id DESC LIMIT 1", [$row['quote_no']])->fetch();
        $resp = null;
        if ($done) { $d = json_decode((string)$done['detail'], true) ?: []; $resp = ['type' => $done['type'], 'name' => $d['name'] ?? '', 'at' => $done['created_at']]; }
        json_out(['available' => true, 'quote' => [
            'quote_no' => $row['quote_no'], 'rev' => (int)$row['rev'], 'division' => $row['division'], 'title' => $row['title'], 'status' => $row['status'],
            'quote_date' => $row['quote_date'], 'valid_until' => $row['valid_until'], 'client' => json_decode((string)$row['client_json'], true) ?: new stdClass(), 'data' => $data,
        ], 'settings' => $st, 'response' => $resp, 'expired' => $row['valid_until'] < date('Y-m-d') && $row['status'] !== 'accepted']);
    }

    if ($act === 'respond' && $method === 'POST') {
        if (!$available) fail('This quotation is being updated and is not open for response yet. Please contact us.', 409);
        if ($row['status'] !== 'sent') fail('This quotation has already been ' . $row['status'] . '.', 409);
        if ($row['valid_until'] < date('Y-m-d')) fail('This quotation has expired. Please contact us for a refreshed quote.', 409);
        $d = body();
        $name = str($d['name'] ?? '', 120);
        $data = json_decode((string)$row['data'], true) ?: [];
        $detail = ['name' => $name, 'note' => str($d['note'] ?? '', 500)];

        if (($d['action'] ?? '') === 'accept') {
            if ($name === '') fail('Please type your full name to accept');
            $opts = $data['options'] ?? [];
            if ($opts) {
                $sel = (int)($d['option'] ?? 0);
                if ($sel < 0 || $sel >= count($opts)) fail('Please choose an option');
                $data['selected_option'] = $sel;
                $detail['option'] = $opts[$sel]['name'] ?? '';
            }
            [$sub, $disc, $tax, $round, $total] = compute_totals($data);
            // the client must be accepting the exact amount they were looking at
            if (!isset($d['expected_total']) || !is_numeric($d['expected_total'])) fail('Please reload the page and try again');
            if (abs((float)$d['expected_total'] - $total) > 0.01) fail('This quotation was updated while you were viewing it. Please reload the page to see the latest version.', 409);
            $sig = (string)($d['signature'] ?? '');
            if ($sig !== '' && preg_match('#^data:image/png;base64,[A-Za-z0-9+/=]+$#', $sig) && strlen($sig) <= 120000) $detail['signature'] = $sig;
            // atomic: only one visitor can move the quote from "sent" to "accepted"
            $st = q("UPDATE quotes SET status='accepted', data=?, subtotal=?, discount=?, tax=?, round_off=?, total=?, updated_at=? WHERE id=? AND status='sent' AND is_latest=1",
                [json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, now(), $row['id']]);
            if ($st->rowCount() !== 1) fail('This quotation has already been responded to.', 409);
            $detail['total'] = $total;
            q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'accepted', json_encode($detail, JSON_UNESCAPED_UNICODE), $name, $ip, now()]);
            $row['total'] = $total; $row['status'] = 'accepted';
            notify_quote_event($row, 'accepted', $detail);
            json_out(['ok' => true, 'status' => 'accepted']);
        }
        if (($d['action'] ?? '') === 'reject') {
            $st = q("UPDATE quotes SET status='rejected', updated_at=? WHERE id=? AND status='sent' AND is_latest=1", [now(), $row['id']]);
            if ($st->rowCount() !== 1) fail('This quotation has already been responded to.', 409);
            q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'rejected', json_encode($detail, JSON_UNESCAPED_UNICODE), $name ?: null, $ip, now()]);
            notify_quote_event($row, 'declined', $detail);
            json_out(['ok' => true, 'status' => 'rejected']);
        }
        fail('Unknown action');
    }
    fail('Not found', 404);
} catch (PDOException $e) {
    error_log('DB error: ' . $e->getMessage());
    app_log_error('DB error: ' . $e->getMessage());
    fail('Database error', 500);
} catch (Throwable $e) {
    error_log('Error: ' . $e->getMessage());
    app_log_error('Error: ' . $e->getMessage());
    fail('Server error', 500);
}

/** After the response is sent: tell the team what the client did, confirm to the client, and start the project. */
function notify_quote_event(array $row, string $what, array $detail): void
{
    after_response(function () use ($row, $what, $detail) {
        $e = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
        $cl = json_decode((string)$row['client_json'], true) ?: [];
        $who = $e($detail['name'] ?? '') ?: $e($cl['name'] ?? 'The client');
        $link = app_base_url() . '/index.html#/quotes/' . (int)$row['id'];
        $inr = 'Rs ' . number_format((float)$row['total'], 2);
        $creator = !empty($row['created_by']) ? (q('SELECT email FROM users WHERE id = ?', [(int)$row['created_by']])->fetch()['email'] ?? null) : null;
        if ($what === 'viewed') {
            notify_admins('Opened: ' . $row['quote_no'] . ' - ' . ($cl['name'] ?? ''), 'Your quotation was opened', '<p><b>' . $e($cl['name'] ?? 'The client') . '</b> just opened quotation <b>' . $e($row['quote_no']) . '</b> (' . $inr . ') for the first time.</p>', ['Open quotation', $link], $creator);
            return;
        }
        if ($what === 'declined') {
            notify_admins('Declined: ' . $row['quote_no'] . ' - ' . ($cl['name'] ?? ''), 'Quotation declined', '<p>' . $who . ' declined quotation <b>' . $e($row['quote_no']) . '</b>.' . (!empty($detail['note']) ? '<br>Note: ' . $e($detail['note']) : '') . '</p>', ['Open quotation', $link], $creator);
            return;
        }
        // accepted
        $pid = null; $note = '';
        if (get_setting('auto_project') !== '0' && (float)$row['total'] > 0 && !q('SELECT 1 FROM projects WHERE quote_no = ?', [$row['quote_no']])->fetch()) {
            try {
                $fresh = q('SELECT * FROM quotes WHERE id = ?', [$row['id']])->fetch();
                $pid = create_project_from_quote($fresh);
                q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'project_created', json_encode(['project_id' => $pid]), 'auto', null, now()]);
                $note = '<br>A project with the payment schedule has been created automatically.';
            } catch (Throwable $ex) { if (db()->inTransaction()) db()->rollBack(); app_log_error('Auto-project failed: ' . $ex->getMessage()); }
        }
        notify_admins('ACCEPTED: ' . $row['quote_no'] . ' - ' . ($cl['name'] ?? '') . ' - ' . $inr, 'Quotation accepted', '<p>' . $who . ' accepted quotation <b>' . $e($row['quote_no']) . '</b> for <b>' . $inr . '</b>.' . (!empty($detail['option']) ? '<br>Option: ' . $e($detail['option']) : '') . $note . '</p>', [$pid ? 'Open project' : 'Open quotation', $pid ? app_base_url() . '/index.html#/projects/' . $pid : $link], $creator);
        if (get_setting('confirm_client') !== '0' && mail_configured() && filter_var($cl['email'] ?? '', FILTER_VALIDATE_EMAIL)) {
            $co = (string)(get_setting('company_name') ?: 'Infraura');
            send_mail($cl['email'], 'Thank you - quotation ' . $row['quote_no'] . ' accepted', email_html('Thank you', '<p>Dear ' . $who . ',</p><p>Thank you for accepting quotation <b>' . $e($row['quote_no']) . '</b> (' . $inr . '). Our team will contact you shortly to schedule the work.</p><p>' . $e($co) . '</p>'));
        }
    });
}

/** Client-facing change order: view it and approve or decline online (the signed approval is stored on the variation). */
function variation_public(string $act, string $method, string $tok, string $ip): void
{
    $v = q('SELECT v.*, p.name AS pname, p.quote_no, p.tax_rate, p.base_value, p.id AS pid FROM project_variations v JOIN projects p ON p.id = v.project_id WHERE v.approval_token = ?', [$tok])->fetch();
    if (!$v) fail('This link is not valid or has been withdrawn', 404);
    $gst = round((float)$v['amount'] * (float)$v['tax_rate'] / 100, 2); $total = round((float)$v['amount'] + $gst, 2);
    if ($act === 'variation' && $method === 'GET') {
        $st = [];
        foreach (['company_name', 'company_address', 'company_phone', 'company_email', 'company_gstin', 'signatory'] as $k) $st[$k] = get_setting($k) ?? '';
        $appr = (float)q("SELECT COALESCE(SUM(amount),0) AS s FROM project_variations WHERE project_id = ? AND status = 'approved'", [$v['pid']])->fetch()['s'];
        $before = round((float)$v['base_value'] + $appr * (1 + (float)$v['tax_rate'] / 100), 2);
        json_out(['settings' => $st, 'variation' => ['title' => $v['title'], 'note' => $v['note'], 'amount' => (float)$v['amount'], 'gst' => $gst, 'total' => $total, 'gst_rate' => (float)$v['tax_rate'], 'status' => $v['status'],
            'decided_by' => $v['decided_by'], 'decided_at' => $v['decided_at']], 'project' => ['name' => $v['pname'], 'quote_no' => $v['quote_no']], 'contract_before' => $before, 'contract_after' => round($before + ($v['status'] === 'approved' ? 0 : $total), 2)]);
    }
    if ($act === 'variation-respond' && $method === 'POST') {
        if ($v['status'] !== 'proposed') fail('This change order has already been ' . $v['status'] . '.', 409);
        $d = body(); $name = str($d['name'] ?? '', 120); $action = (string)($d['action'] ?? '');
        if (!in_array($action, ['accept', 'decline'], true)) fail('Unknown action');
        if ($action === 'accept' && $name === '') fail('Please type your full name to approve');
        if (!isset($d['expected_total']) || !is_numeric($d['expected_total']) || abs((float)$d['expected_total'] - $total) > 0.01) fail('This change order was updated while you were viewing it. Please reload the page.', 409);
        $new = $action === 'accept' ? 'approved' : 'rejected';
        db()->beginTransaction();
        $up = q("UPDATE project_variations SET status = ?, decided_by = ?, decided_at = ?, decided_ip = ?, client_note = ? WHERE id = ? AND status = 'proposed'", [$new, $name ?: null, now(), $ip, str($d['note'] ?? '', 500) ?: null, $v['id']]);
        if ($up->rowCount() !== 1) { db()->rollBack(); fail('This change order has already been responded to.', 409); }
        if ($new === 'approved') { $mid = variation_milestone((int)$v['pid'], $v); q('UPDATE project_variations SET milestone_id = ? WHERE id = ?', [$mid, $v['id']]); }
        db()->commit();
        q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$v['quote_no'], 0, 'variation_' . $new, json_encode(['title' => $v['title'], 'total' => $total], JSON_UNESCAPED_UNICODE), $name ?: null, $ip, now()]);
        $title = $v['title']; $pname = $v['pname']; $ok = $new === 'approved';
        after_response(function () use ($title, $pname, $ok, $name, $total) {
            $e = fn($x) => htmlspecialchars((string)$x, ENT_QUOTES, 'UTF-8');
            notify_admins(($ok ? 'Change order APPROVED: ' : 'Change order declined: ') . $title, $ok ? 'Change order approved' : 'Change order declined', '<p>' . $e($name ?: 'The client') . ($ok ? ' approved' : ' declined') . ' the change order <b>' . $e($title) . '</b> on <b>' . $e($pname) . '</b> (Rs ' . number_format($total, 2) . ' incl. GST).' . ($ok ? '<br>A billing milestone has been added to the project.' : '') . '</p>');
        });
        json_out(['ok' => true, 'status' => $new]);
    }
    fail('Not found', 404);
}
