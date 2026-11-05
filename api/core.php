<?php
declare(strict_types=1);
require_once __DIR__ . '/lib.php';
// Shared business logic used by the web API (index.php) and the MCP endpoint (mcp.php).

function all_settings_raw(): array
{
    $out = [];
    foreach (q('SELECT k, v FROM settings')->fetchAll() as $r) $out[$r['k']] = (string)$r['v'];
    return $out;
}

/** Settings for the browser. Secrets (SMTP password, cron key) never go to staff; admins see the password masked. */
function all_settings(bool $admin = false): array
{
    $out = all_settings_raw();
    unset($out['schema_v']);
    if (!$admin) { unset($out['smtp_pass'], $out['cron_key'], $out['smtp_user'], $out['smtp_host']); }
    elseif (($out['smtp_pass'] ?? '') !== '') $out['smtp_pass'] = '********';
    return $out;
}

// ---------------- rates ----------------
function rates_list(?string $division = null): array
{
    $sql = 'SELECT id,division,category,name,unit,rate,cost,description,active,sort FROM rate_items';
    $p = [];
    if ($division) {
        $sql .= ' WHERE division = ?';
        $p[] = $division;
    }
    $rows = q($sql . ' ORDER BY division, category, sort, name', $p)->fetchAll();
    foreach ($rows as &$r) {
        $r['id'] = (int)$r['id'];
        $r['rate'] = (float)$r['rate'];
        $r['cost'] = (float)$r['cost'];
        $r['active'] = (int)$r['active'];
    }
    return $rows;
}

function rate_fields(array $d): array
{
    $div = (string)($d['division'] ?? '');
    if (!isset(DIVISIONS[$div])) fail('Invalid division');
    $name = str($d['name'] ?? '', 255);
    if ($name === '') fail('Item name is required');
    return [$div, str($d['category'] ?? '', 120), $name, str($d['unit'] ?? '', 30), round(num($d['rate'] ?? 0), 2), str($d['description'] ?? '', 1000), empty($d['active']) && array_key_exists('active', $d) ? 0 : 1, round(max(num($d['cost'] ?? 0), 0), 2)];
}

// ---------------- templates ----------------
function templates_list(): array
{
    $rows = q('SELECT id,name,division,data FROM quote_templates ORDER BY division, name')->fetchAll();
    foreach ($rows as &$r) {
        $r['id'] = (int)$r['id'];
        $r['data'] = json_decode((string)$r['data'], true) ?: new stdClass();
    }
    return $rows;
}

// ---------------- quotes ----------------
function quote_row_out(array $r, bool $full): array
{
    foreach (['id', 'rev', 'is_latest', 'client_id', 'created_by'] as $k) {
        if (isset($r[$k])) $r[$k] = (int)$r[$k];
    }
    foreach (['subtotal', 'discount', 'tax', 'round_off', 'total'] as $k) $r[$k] = (float)$r[$k];
    $r['client'] = json_decode((string)($r['client_json'] ?? ''), true) ?: new stdClass();
    unset($r['client_json']);
    if ($full) {
        $r['data'] = json_decode((string)($r['data'] ?? ''), true) ?: new stdClass();
    } else {
        unset($r['data']);
    }
    return $r;
}

function check_amount(float $v): float
{
    if ($v < 0) fail('Quantities and rates cannot be negative');
    if ($v > MAX_AMOUNT) fail('A quantity or rate is unrealistically large - please check the figures');
    return $v;
}

function clean_sections($in): array
{
    $secs = [];
    foreach ((is_array($in) ? $in : []) as $s) {
        if (!is_array($s)) continue;
        $items = [];
        foreach (($s['items'] ?? []) as $it) {
            if (!is_array($it)) continue;
            $items[] = [
                'desc' => str($it['desc'] ?? '', 1000), 'unit' => str($it['unit'] ?? '', 30),
                'qty' => check_amount(num($it['qty'] ?? 0)), 'rate' => check_amount(num($it['rate'] ?? 0)), 'cost' => min(max(num($it['cost'] ?? 0), 0), MAX_AMOUNT), 'note' => str($it['note'] ?? '', 500),
            ];
        }
        $imgs = [];
        foreach ((is_array($s['images'] ?? null) ? $s['images'] : []) as $im) {
            if (is_string($im) && count($imgs) < 3 && strlen($im) <= 220000 && preg_match('#^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$#', $im)) $imgs[] = $im;
        }
        $secs[] = ['title' => str($s['title'] ?? '', 190), 'items' => $items, 'images' => $imgs];
    }
    return $secs;
}

function clean_quote_input(array $d, ?string $existingDivision = null): array
{
    $division = $existingDivision ?? (string)($d['division'] ?? '');
    if (!isset(DIVISIONS[$division])) fail('Invalid division');
    $title = str($d['title'] ?? '', 255);
    $data = $d['data'] ?? [];
    if (!is_array($data)) fail('Invalid quote data');
    $secs = clean_sections($data['sections'] ?? []);
    $opts = [];
    foreach ((is_array($data['options'] ?? null) ? $data['options'] : []) as $o) {
        if (!is_array($o) || count($opts) >= 6) continue;
        $opts[] = ['name' => str($o['name'] ?? '', 120) ?: 'Option', 'note' => str($o['note'] ?? '', 500), 'sections' => clean_sections($o['sections'] ?? [])];
    }
    $sel = (int)($data['selected_option'] ?? 0);
    if ($sel < 0 || $sel >= count($opts)) $sel = 0;
    $pay = [];
    foreach (($data['payment_schedule'] ?? []) as $p) {
        if (is_array($p) && str($p['label'] ?? '') !== '') $pay[] = ['label' => str($p['label'], 190), 'percent' => num($p['percent'] ?? 0)];
    }
    $terms = [];
    foreach (($data['terms'] ?? []) as $t) {
        if (is_string($t) && trim($t) !== '') $terms[] = mb_substr(trim($t), 0, 600);
    }
    $disc = is_array($data['discount'] ?? null) ? $data['discount'] : [];
    $clean = [
        'sections' => $secs,
        'options' => $opts,
        'selected_option' => $sel,
        'discount' => ['type' => ($disc['type'] ?? 'percent') === 'flat' ? 'flat' : 'percent', 'value' => max(0, num($disc['value'] ?? 0))],
        'tax_rate' => min(max(num($data['tax_rate'] ?? 18), 0), 100),
        'round_off' => !empty($data['round_off']),
        'payment_schedule' => $pay,
        'terms' => $terms,
        'notes' => str($data['notes'] ?? '', 3000),
        'scope' => str($data['scope'] ?? '', 3000),
        'site_address' => str($data['site_address'] ?? '', 500),
        'area_sqft' => num($data['area_sqft'] ?? 0),
        'pmc' => is_array($data['pmc'] ?? null) ? $data['pmc'] : null,
        'roofcalc' => clean_roofcalc($data['roofcalc'] ?? null),
        'gst_mode' => in_array($data['gst_mode'] ?? '', ['intra', 'inter'], true) ? $data['gst_mode'] : '',
        'hsn' => str($data['hsn'] ?? '', 20),
        'source' => str($data['source'] ?? '', 40),
        'lang' => in_array($data['lang'] ?? '', ['hi', 'ta', 'te', 'kn', 'ml'], true) ? $data['lang'] : '',
    ];
    $lines = 0;
    foreach (effective_sections($clean) as $s) $lines += count($s['items']);
    foreach ($clean['options'] as $o) foreach ($o['sections'] as $s) $lines += count($s['items']);
    if ($lines > 1500) fail('Too many line items on one quote (limit 1500) - split it into two quotes');
    if (strlen(json_encode($clean)) > 3500000) fail('This quote is too large to save - remove some images or lines');
    foreach ([compute_totals($clean)] as $tt) if (abs($tt[4]) > MAX_AMOUNT * 10) fail('Quote total is unrealistically large - please check the figures');
    foreach ($clean['options'] as $oi => $_o) { $tmp = $clean; $tmp['selected_option'] = $oi; if (abs(compute_totals($tmp)[4]) > MAX_AMOUNT * 10) fail('An option total is unrealistically large - please check the figures'); }
    $c = is_array($d['client'] ?? null) ? $d['client'] : [];
    $client = ['name' => str($c['name'] ?? '', 190), 'contact_person' => str($c['contact_person'] ?? '', 120), 'phone' => str($c['phone'] ?? '', 40),
        'email' => str($c['email'] ?? '', 190), 'address' => str($c['address'] ?? '', 1000), 'gstin' => str($c['gstin'] ?? '', 30)];
    $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($d['quote_date'] ?? '')) ? $d['quote_date'] : date('Y-m-d');
    $valid = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($d['valid_until'] ?? '')) ? $d['valid_until'] : date('Y-m-d', strtotime($date . ' +' . (int)(get_setting('validity_days') ?: 15) . ' days'));
    return [$division, $title, $clean, $client, $date, $valid, (int)($d['client_id'] ?? 0) ?: null];
}

function clean_roofcalc($r): ?array
{
    if (!is_array($r)) return null;
    $out = [];
    foreach (['type', 'gutter'] as $k) $out[$k] = str($r[$k] ?? '', 10);
    foreach (['len', 'wid', 'slope', 'eave', 'gable', 'height', 'waste', 'pspace', 'purlinkg', 'framekg', 'screws', 'turbo', 'sky'] as $k) $out[$k] = isset($r[$k]) && $r[$k] !== '' ? num($r[$k]) : '';
    $out['mats'] = array_values(array_filter(array_map(fn($x) => str($x, 12), is_array($r['mats'] ?? null) ? $r['mats'] : []), 'strlen'));
    $out['custom'] = [];
    foreach ((is_array($r['custom'] ?? null) ? $r['custom'] : []) as $k => $v) {
        if ($v !== '' && is_numeric($v)) $out['custom'][str($k, 20)] = (float)$v;
    }
    return $out;
}

function resolve_client(?int $clientId, array $client): array
{
    if ($clientId) {
        $ex = q('SELECT 1 FROM clients WHERE id = ?', [$clientId])->fetch();
        if (!$ex) $clientId = null;
    }
    if (!$clientId && $client['name'] !== '') {
        q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)',
            [$client['name'], $client['contact_person'], $client['phone'], $client['email'], $client['address'], $client['gstin'], now()]);
        $clientId = (int)db()->lastInsertId();
    }
    return [$clientId, $client];
}

function audit(array $user, string $action, string $detail = ''): void
{
    q('INSERT INTO audit_log (user_name,action,detail,created_at) VALUES (?,?,?,?)', [$user['name'] ?? '', $action, mb_substr($detail, 0, 500), now()]);
}

function quote_margin(array $data): array
{
    $cost = 0.0; $rev = 0.0;
    foreach (effective_sections($data) as $s) foreach (($s['items'] ?? []) as $it) {
        $a = num($it['qty'] ?? 0) * num($it['rate'] ?? 0);
        if ($a > 0 && num($it['cost'] ?? 0) > 0) { $cost += num($it['qty'] ?? 0) * num($it['cost']); $rev += $a; }
    }
    $t = compute_totals($data);
    $disc = $t[0] > 0 ? $t[1] / $t[0] : 0;
    return [$rev * (1 - $disc), $cost];
}

function reports(): array
{
    $since = date('Y-m-01', strtotime('-11 months'));
    $monthly = q("SELECT substr(quote_date,1,7) AS month, COUNT(*) AS n, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS won, COALESCE(SUM(total),0) AS value, COALESCE(SUM(CASE WHEN status='accepted' THEN total ELSE 0 END),0) AS won_value FROM quotes WHERE is_latest = 1 AND quote_date >= ? GROUP BY substr(quote_date,1,7) ORDER BY month", [$since])->fetchAll();
    $div = q("SELECT division, COUNT(*) AS n, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS won, SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS lost, COALESCE(SUM(total),0) AS value, COALESCE(SUM(CASE WHEN status='accepted' THEN total ELSE 0 END),0) AS won_value FROM quotes WHERE is_latest = 1 GROUP BY division")->fetchAll();
    $usr = q("SELECT COALESCE(u.name,'(unknown)') AS name, COUNT(*) AS n, SUM(CASE WHEN q.status='accepted' THEN 1 ELSE 0 END) AS won, COALESCE(SUM(CASE WHEN q.status='accepted' THEN q.total ELSE 0 END),0) AS won_value FROM quotes q LEFT JOIN users u ON u.id = q.created_by WHERE q.is_latest = 1 GROUP BY u.name ORDER BY won_value DESC")->fetchAll();
    $age = ['0-3 days' => [0, 0.0], '4-7 days' => [0, 0.0], '8-14 days' => [0, 0.0], '15+ days' => [0, 0.0]];
    foreach (q("SELECT total, updated_at FROM quotes WHERE is_latest = 1 AND status = 'sent'")->fetchAll() as $r) {
        $d = (int)floor((time() - strtotime($r['updated_at'])) / 86400);
        $k = $d <= 3 ? '0-3 days' : ($d <= 7 ? '4-7 days' : ($d <= 14 ? '8-14 days' : '15+ days'));
        $age[$k][0]++; $age[$k][1] += (float)$r['total'];
    }
    $src = []; $mar = [];
    foreach (q('SELECT division, status, total, data FROM quotes WHERE is_latest = 1 ORDER BY id DESC LIMIT 3000')->fetchAll() as $r) {
        $d = json_decode((string)$r['data'], true) ?: [];
        $s = ($d['source'] ?? '') ?: '(not set)';
        $src[$s] ??= ['source' => $s, 'n' => 0, 'won' => 0, 'won_value' => 0.0];
        $src[$s]['n']++;
        if ($r['status'] === 'accepted') { $src[$s]['won']++; $src[$s]['won_value'] += (float)$r['total']; }
        [$rev, $cost] = quote_margin($d);
        if ($rev > 0) { $mar[$r['division']] ??= ['division' => $r['division'], 'rev' => 0.0, 'cost' => 0.0, 'n' => 0]; $mar[$r['division']]['rev'] += $rev; $mar[$r['division']]['cost'] += $cost; $mar[$r['division']]['n']++; }
    }
    $cast = function (array $rows) { foreach ($rows as &$r) foreach ($r as $k => $v) if (is_numeric($v) && $k !== 'month' && $k !== 'division' && $k !== 'name') $r[$k] = $v + 0; return $rows; };
    return ['monthly' => $cast($monthly), 'by_division' => $cast($div), 'by_user' => $cast($usr), 'sources' => array_values($src), 'margin' => array_values($mar),
        'aging' => array_map(fn($k, $v) => ['bucket' => $k, 'n' => $v[0], 'value' => round($v[1], 2)], array_keys($age), array_values($age)), 'receivables' => receivables_summary()];
}

function log_event(string $quoteNo, int $rev, string $type, array $detail, ?string $actor = null): void
{
    q('INSERT INTO quote_events (quote_no,rev,type,detail,actor,ip,created_at) VALUES (?,?,?,?,?,?,?)',
        [$quoteNo, $rev, $type, json_encode($detail, JSON_UNESCAPED_UNICODE), $actor, substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45), now()]);
}

// ---------------- dashboard ----------------
function dashboard(): array
{
    $byStatus = q("SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 GROUP BY status")->fetchAll();
    $byDiv = q("SELECT division, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 GROUP BY division")->fetchAll();
    $since = date('Y-m-01', strtotime('-5 months'));
    $monthly = q("SELECT substr(quote_date,1,7) AS month, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE is_latest = 1 AND quote_date >= ? GROUP BY substr(quote_date,1,7) ORDER BY month", [$since])->fetchAll();
    $recent = q('SELECT id,quote_no,rev,division,client_json,title,status,quote_date,total FROM quotes WHERE is_latest = 1 ORDER BY id DESC LIMIT 8')->fetchAll();
    $cast = function (array $rows) {
        foreach ($rows as &$r) {
            if (isset($r['n'])) $r['n'] = (int)$r['n'];
            if (isset($r['value'])) $r['value'] = (float)$r['value'];
        }
        return $rows;
    };
    return [
        'by_status' => $cast($byStatus), 'by_division' => $cast($byDiv), 'monthly' => $cast($monthly),
        'recent' => array_map(fn($r) => quote_row_out($r + ['subtotal' => 0, 'discount' => 0, 'tax' => 0, 'round_off' => 0], false), $recent),
        'clients' => (int)q('SELECT COUNT(*) AS n FROM clients')->fetch()['n'],
        'receivables' => receivables_summary(),
        'amc_due' => q("SELECT p.id, p.name, p.amc_end, p.amc_note, c.name AS client_name, c.phone AS client_phone FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.amc_end IS NOT NULL AND p.amc_end <> '' AND p.amc_end >= ? AND p.amc_end <= ? ORDER BY p.amc_end LIMIT 20", [date('Y-m-d', strtotime('-14 days')), date('Y-m-d', strtotime('+60 days'))])->fetchAll(),
        'follow_up' => array_map(fn($r) => quote_row_out($r + ['subtotal' => 0, 'discount' => 0, 'tax' => 0, 'round_off' => 0], false),
            q("SELECT q.id,q.quote_no,q.rev,q.division,q.client_json,q.title,q.status,q.quote_date,q.valid_until,q.total,q.updated_at,
                (SELECT COUNT(*) FROM quote_events e WHERE e.quote_no = q.quote_no AND e.type = 'view') AS views
                FROM quotes q WHERE q.is_latest = 1 AND q.status = 'sent' AND q.updated_at <= ? ORDER BY q.updated_at LIMIT 10", [date('Y-m-d H:i:s', strtotime('-3 days'))])->fetchAll()),
    ];
}

// ---------------- clients ----------------
function client_fields(array $d): array
{
    $name = str($d['name'] ?? '', 190);
    if ($name === '') fail('Client name is required');
    return [$name, str($d['contact_person'] ?? '', 120), str($d['phone'] ?? '', 40), str($d['email'] ?? '', 190), str($d['address'] ?? '', 1000), str($d['gstin'] ?? '', 30)];
}

/** Create a new draft quote from raw input (same validation as the web UI). Returns id, quote_no and totals. */
function create_quote(array $user, array $in): array
{
    [$division, $title, $data, $client, $date, $valid, $cid] = clean_quote_input($in);
    [$cid, $client] = resolve_client($cid, $client);
    [$sub, $disc, $tax, $round, $total] = compute_totals($data);
    $newId = 0; $no = '';
    for ($try = 0; $try < 8 && !$newId; $try++) { // two people saving at once can pick the same number: retry
        $no = next_quote_no($division, $date);
        try {
            q('INSERT INTO quotes (quote_no,rev,is_latest,division,client_id,client_json,title,status,quote_date,valid_until,data,subtotal,discount,tax,round_off,total,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [$no, 0, 1, $division, $cid, json_encode($client, JSON_UNESCAPED_UNICODE), $title, 'draft', $date, $valid, json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, $user['id'] ?? null, now(), now()]);
            $newId = (int)db()->lastInsertId();
        } catch (PDOException $e) {
            if ($e->getCode() !== '23000') throw $e;
            usleep(random_int(5000, 60000));
        }
    }
    if (!$newId) fail('Could not allocate a quote number - please try again', 503);
    audit($user, 'quote.create', $no . ' ' . $title);
    return ['id' => $newId, 'quote_no' => $no, 'subtotal' => $sub, 'discount' => $disc, 'tax' => $tax, 'round_off' => $round, 'total' => $total, 'client_id' => $cid];
}

// ---------------- roofing calculator (server-side port of assets/roof.js; parity-tested) ----------------
const ROOF_MATS = [
    'gi'      => ['label' => 'GI colour coated (PPGI) 0.40 mm', 'short' => 'GI', 'match' => 'GI colour coated sheet 0.40', 'def' => 88],
    'gi55'    => ['label' => 'GI colour coated (PPGI) 0.55 mm', 'short' => 'GI 0.55', 'match' => 'GI colour coated sheet 0.55', 'def' => 118],
    'galv'    => ['label' => 'Galvalume 0.45 mm', 'short' => 'Galvalume', 'match' => 'Galvalume (Zn-Al) sheet 0.45', 'def' => 100],
    'upvc'    => ['label' => 'UPVC trapezoidal 2.5 mm', 'short' => 'UPVC', 'match' => 'UPVC trapezoidal roofing sheet 2.5', 'def' => 140],
    'upvcasa' => ['label' => 'UPVC ASA tile-profile 3 mm', 'short' => 'UPVC ASA', 'match' => 'UPVC tile-profile (ASA', 'def' => 175],
    'puf30'   => ['label' => 'PUF sandwich panel 30 mm', 'short' => 'PUF 30', 'match' => 'PUF sandwich panel 30 mm', 'def' => 215],
    'puf50'   => ['label' => 'PUF sandwich panel 50 mm', 'short' => 'PUF 50', 'match' => 'PUF sandwich panel 50 mm', 'def' => 270],
    'puf75'   => ['label' => 'PUF sandwich panel 75 mm', 'short' => 'PUF 75', 'match' => 'PUF sandwich panel 75 mm', 'def' => 335],
    'alu'     => ['label' => 'Aluminium roofing 0.60 mm coated', 'short' => 'Aluminium', 'match' => 'Aluminium roofing sheet 0.60', 'def' => 195],
    'poly'    => ['label' => 'Polycarbonate multiwall 6 mm', 'short' => 'Polycarbonate', 'match' => 'Polycarbonate multiwall sheet 6', 'def' => 150],
];
const ROOF_PARTS = [
    'purlin' => ['match' => 'GI / MS purlins (Z / C)', 'def' => 88],
    'frame'  => ['match' => 'MS structural truss / rafter', 'def' => 92],
    'ridge'  => ['match' => 'Ridge cap flashing (PPGI)', 'def' => 185],
    'barge'  => ['match' => 'Barge / gable flashing', 'def' => 160],
    'gutter' => ['match' => 'Box gutter - GI 0.8', 'def' => 380],
    'pipe'   => ['match' => 'Downpipe - GI / MS 100', 'def' => 220],
    'screw'  => ['match' => 'Self-drilling roofing screws', 'def' => 4],
    'turbo'  => ['match' => 'Turbo ventilator 24 inch', 'def' => 4500],
    'sky'    => ['match' => 'FRP roofing sheet 1.5', 'def' => 85],
];

function roof_rates_from_db(): array
{
    return q("SELECT name, rate, cost FROM rate_items WHERE active = 1 AND division = 'roofing' ORDER BY category, sort, name")->fetchAll();
}

function roof_lookup(array $rates, string $match): ?array
{
    foreach ($rates as $r) if (stripos((string)$r['name'], $match) !== false) return $r;
    return null;
}

function roof_geometry(array $p): ?array
{
    $L = num($p['len'] ?? 0); $W = num($p['wid'] ?? 0);
    $th = min(max(num($p['slope'] ?? 0), 0), 45) * M_PI / 180;
    if ($L <= 0 || $W <= 0) return null;
    $cos = cos($th) ?: 1;
    $eave = max(num($p['eave'] ?? 0), 0); $gab = max(num($p['gable'] ?? 0), 0);
    $roofLen = $L + 2 * $gab;
    $type = $p['type'] ?? 'gable';
    $ridge = 0; $barge = 0;
    if ($type === 'gable') { $slopes = 2; $slopeLen = ($W / 2 + $eave) / $cos; $area = $slopes * $slopeLen * $roofLen; $ridge = $roofLen; $barge = 4 * $slopeLen; $gutterRft = 2 * $roofLen; }
    elseif ($type === 'shed') { $slopes = 1; $slopeLen = ($W + 2 * $eave) / $cos; $area = $slopeLen * $roofLen; $barge = 2 * $slopeLen; $gutterRft = $roofLen; $ridge = $roofLen; }
    else { $slopes = 1; $slopeLen = $W + 2 * $eave; $area = $slopeLen * $roofLen; $barge = 0; $gutterRft = $roofLen; $ridge = 0; }
    $plan = $L * $W; $waste = max(num($p['waste'] ?? 0), 0) / 100;
    $billed = $area * (1 + $waste);
    $pspace = num($p['pspace'] ?? 0) ?: 4;
    $rows = (int)ceil($slopeLen / max($pspace, 1)) + 1;
    $purlinRft = $rows * $roofLen * $slopes;
    $gut = ($p['gutter'] ?? 'yes') === 'yes';
    $pipes = $gut ? max((int)ceil($gutterRft / 30), 1) : 0;
    $turboEvery = num($p['turbo'] ?? 0);
    return [
        'plan' => $plan, 'area' => $area, 'billed' => $billed, 'slopeLen' => $slopeLen, 'slopes' => $slopes, 'roofLen' => $roofLen, 'ridge' => $ridge, 'barge' => $barge,
        'gutterRft' => $gut ? $gutterRft : 0, 'pipes' => $pipes, 'pipeRft' => $pipes * max(num($p['height'] ?? 0), 0),
        'purlinKg' => ($p['structure'] ?? 'yes') === 'no' ? 0 : $purlinRft * num($p['purlinkg'] ?? 0), 'purlinRft' => $purlinRft, 'frameKg' => ($p['structure'] ?? 'yes') === 'no' ? 0 : $plan * num($p['framekg'] ?? 0),
        'screws' => (int)ceil($billed * num($p['screws'] ?? 0)), 'turbo' => $turboEvery > 0 ? max((int)round($plan / $turboEvery), 0) : 0,
        'skyArea' => $area * max(num($p['sky'] ?? 0), 0) / 100,
    ];
}

function roof_defaults(array $in): array
{
    $d = ['structure' => 'yes', 'type' => 'gable', 'len' => 0, 'wid' => 0, 'slope' => 10, 'eave' => 1, 'gable' => 0.5, 'height' => 12, 'waste' => 7, 'pspace' => 4, 'purlinkg' => 1.5, 'framekg' => 2.5, 'screws' => 0.7, 'turbo' => 1000, 'sky' => 0, 'gutter' => 'yes'];
    foreach ($d as $k => $v) if (array_key_exists($k, $in) && $in[$k] !== '' && $in[$k] !== null) $d[$k] = in_array($k, ['type', 'gutter', 'structure'], true) ? (string)$in[$k] : num($in[$k]);
    if (!in_array($d['type'], ['gable', 'shed', 'flat'], true)) $d['type'] = 'gable';
    return $d;
}

function roof_in_words(float $n): string
{ // en-IN digit grouping, no decimals
    $s = (string)(int)round($n); $neg = $s[0] === '-'; $s = ltrim($s, '-');
    if (strlen($s) > 3) { $last = substr($s, -3); $rest = substr($s, 0, -3); $rest = preg_replace('/\B(?=(\d{2})+(?!\d))/', ',', $rest); $s = $rest . ',' . $last; }
    return ($neg ? '-' : '') . $s;
}

/** Price one roof for each requested material. $custom = [key => rate override]. Returns null when length/width are missing. */
function roof_calc(array $in, array $mats, array $rates, array $custom = []): ?array
{
    $p = roof_defaults($in);
    $g = roof_geometry($p);
    if (!$g) return null;
    $rate = function (string $key, bool $mat) use ($rates, $custom): float {
        if (isset($custom[$key]) && $custom[$key] !== '' && is_numeric($custom[$key])) return (float)$custom[$key];
        $src = $mat ? ROOF_MATS[$key] : ROOF_PARTS[$key];
        $it = roof_lookup($rates, $src['match']);
        return $it ? (float)$it['rate'] : (float)$src['def'];
    };
    $costOf = function (string $key, bool $mat) use ($rates, $custom, $rate): float {
        $src = $mat ? ROOF_MATS[$key] : ROOF_PARTS[$key];
        $it = roof_lookup($rates, $src['match']);
        $hasCustom = isset($custom[$key]) && $custom[$key] !== '' && (float)$custom[$key] != 0;
        return ($it && !empty($it['cost']) && !$hasCustom) ? (float)$it['cost'] : money($rate($key, $mat) * 0.8);
    };
    $dims = money($p['len']) . ' x ' . money($p['wid']) . ' ft ' . ($p['type'] === 'gable' ? 'gable' : ($p['type'] === 'shed' ? 'mono-slope' : 'flat')) . ' roof, slope ' . rtrim(rtrim(number_format($p['slope'], 4, '.', ''), '0'), '.') . '°';
    $packages = [];
    foreach ($mats as $key) {
        if (!isset(ROOF_MATS[$key])) continue;
        $m = ROOF_MATS[$key];
        $sheetArea = max($g['billed'] - $g['skyArea'] * (1 + $p['waste'] / 100), 0);
        $items = [];
        $add = function (string $desc, string $unit, float $qty, float $rt, ?string $ck, bool $mat = false) use (&$items, $costOf) {
            if ($qty > 0) $items[] = ['desc' => $desc, 'unit' => $unit, 'qty' => money($qty), 'rate' => money($rt), 'cost' => $ck ? $costOf($ck, $mat) : 0];
        };
        $wasteTxt = rtrim(rtrim(number_format($p['waste'], 4, '.', ''), '0'), '.');
        $add("Roof sheet - {$m['label']}, supply & fixing\n({$dims}; roof area " . roof_in_words($g['area']) . " sq ft + {$wasteTxt}% wastage/laps)", 'sq ft', $sheetArea, $rate($key, true), $key, true);
        if ($g['skyArea'] > 0) $add('Translucent FRP skylight sheet - supply & fixing', 'sq ft', $g['skyArea'] * (1 + $p['waste'] / 100), $rate('sky', false), 'sky');
        $add('MS structural frame / truss / rafter - fabrication & erection', 'kg', $g['frameKg'], $rate('frame', false), 'frame');
        $add('GI / MS purlins (Z / C) - supply & fixing', 'kg', $g['purlinKg'], $rate('purlin', false), 'purlin');
        $add('Ridge cap flashing', 'rft', $g['ridge'], $rate('ridge', false), 'ridge');
        $add('Barge / gable flashing', 'rft', $g['barge'], $rate('barge', false), 'barge');
        $add('Roof gutter with end caps & outlets', 'rft', $g['gutterRft'], $rate('gutter', false), 'gutter');
        $add('Downpipe 100 mm with clamps', 'rft', $g['pipeRft'], $rate('pipe', false), 'pipe');
        $add('Self-drilling roofing screws with EPDM washers', 'nos', (float)$g['screws'], $rate('screw', false), 'screw');
        $add('Turbo ventilator 24 inch with base', 'nos', (float)$g['turbo'], $rate('turbo', false), 'turbo');
        $total = 0.0; foreach ($items as $i) $total += money($i['qty'] * $i['rate']);
        $total = money($total);
        $packages[] = ['material' => $key, 'label' => $m['label'], 'sheet_rate_per_sqft' => $rate($key, true), 'lines' => $items, 'total_before_gst' => $total, 'per_sqft_of_plan_area' => $g['plan'] > 0 ? money($total / $g['plan']) : 0];
    }
    return ['inputs' => $p, 'geometry' => array_map(fn($v) => is_float($v) ? round($v, 2) : $v, $g), 'packages' => $packages];
}

/** Folder the app lives in as seen from the web (e.g. "" at the domain root, "/quotes" in a sub-folder). Independent of URL rewriting. */
function app_base_path(): string
{
    $dr = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? '')) ?: '';
    $app = realpath(dirname(__DIR__)) ?: '';
    if ($dr !== '' && $app !== '' && strpos(str_replace('\\', '/', $app) . '/', str_replace('\\', '/', $dr) . '/') === 0) return rtrim(substr(str_replace('\\', '/', $app), strlen(str_replace('\\', '/', $dr))), '/');
    return rtrim(dirname(dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api/x.php'))), '/\\');
}

function app_base_url(): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return ($https ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? 'localhost') . app_base_path();
}

/** Create (or reuse) the private client link for a quote family; moves a draft to "sent". Returns the token. */
function ensure_share_token(array $row, array $user): string
{
    $ex = q('SELECT token FROM quote_shares WHERE quote_no = ?', [$row['quote_no']])->fetch();
    $tok = $ex ? $ex['token'] : bin2hex(random_bytes(16));
    if (!$ex) q('INSERT INTO quote_shares (quote_no,token,created_at) VALUES (?,?,?)', [$row['quote_no'], $tok, now()]);
    return $tok;
}

/** All business data as an array (users without password hashes / secrets). Used by the download and the nightly backup. */
function backup_data(): array
{
    $out = ['exported_at' => now(), 'schema_v' => get_setting('schema_v'), 'app' => 'infraura-quotation-builder'];
    foreach (['settings', 'clients', 'rate_items', 'quotes', 'quote_templates', 'quote_shares', 'quote_events', 'projects', 'project_milestones', 'project_receipts', 'project_variations', 'project_log', 'invoice_history', 'credit_notes', 'audit_log'] as $t) {
        try { $out[$t] = q("SELECT * FROM $t")->fetchAll(); } catch (Throwable $e) { $out[$t] = []; }
    }
    foreach ($out['settings'] as &$s) if (in_array($s['k'], ['smtp_pass', 'cron_key'], true)) $s['v'] = '';   // secrets are never written to backup files
    $out['users'] = q('SELECT id,name,email,role,created_at FROM users')->fetchAll();
    return $out;
}

/** Write a compressed backup file to api/data/backups and prune old ones. Returns [filename, bytes]. */
function backup_to_disk(): array
{
    $dir = data_dir() . '/backups';
    if (!is_dir($dir)) @mkdir($dir, 0750, true);
    if (!is_file($dir . '/.htaccess')) @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    $name = 'backup-' . date('Ymd-His') . '-' . bin2hex(random_bytes(8)) . '.json.gz';   // unguessable even if the web server ignored .htaccess
    $bytes = file_put_contents($dir . '/' . $name, gzencode(json_encode(backup_data(), JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), 6));
    if ($bytes === false) throw new RuntimeException('Could not write the backup file (is api/data writable?)');
    $keep = max(1, (int)(get_setting('backup_keep') ?: 14));
    $files = glob($dir . '/backup-*.json.gz') ?: []; sort($files);
    foreach (array_slice($files, 0, max(0, count($files) - $keep)) as $old) @unlink($old);
    return [$name, $bytes];
}

function backup_files(): array
{
    $files = glob(data_dir() . '/backups/backup-*.json.gz') ?: []; rsort($files);
    return array_map(fn($f) => ['name' => basename($f), 'bytes' => filesize($f), 'at' => date('Y-m-d H:i:s', filemtime($f))], array_slice($files, 0, 30));
}

function revoke_grant(string $grantId): void
{
    q('UPDATE oauth_refresh SET revoked = 1 WHERE grant_id = ?', [$grantId]);
    q('UPDATE api_tokens SET revoked = 1 WHERE grant_id = ?', [$grantId]);
}
