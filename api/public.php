<?php
declare(strict_types=1);
// Public (no login) endpoint used by view.html - a client opens their quotation via a private link,
// can choose an option, and accept (with e-signature) or decline it.
require __DIR__ . '/lib.php';
require __DIR__ . '/migrate.php';

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
        if (!$recent) q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'view', '{}', null, $ip, now()]);
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
            json_out(['ok' => true, 'status' => 'accepted']);
        }
        if (($d['action'] ?? '') === 'reject') {
            $st = q("UPDATE quotes SET status='rejected', updated_at=? WHERE id=? AND status='sent' AND is_latest=1", [now(), $row['id']]);
            if ($st->rowCount() !== 1) fail('This quotation has already been responded to.', 409);
            q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)', [$row['quote_no'], (int)$row['rev'], 'rejected', json_encode($detail, JSON_UNESCAPED_UNICODE), $name ?: null, $ip, now()]);
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
