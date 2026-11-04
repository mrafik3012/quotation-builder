<?php
declare(strict_types=1);
/**
 * Model Context Protocol (MCP) server - lets Claude and other AI assistants use the quotation app.
 *
 * Transport : Streamable HTTP (POST JSON-RPC 2.0), stateless, JSON responses. Spec revisions 2024-11-05 .. 2025-06-18.
 * Auth      : Authorization: Bearer <token>   (tokens are created by an admin in Settings -> AI assistants).
 * Safety    : read-only tokens by default; write tokens can only create/edit DRAFTS. Nothing here can send a quote to a
 *             client, accept/reject, delete, record payments, change settings or touch users. Cost/margin hidden unless allowed.
 */
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/projects.php';

$GLOBALS['FAIL_THROWS'] = true;   // fail() throws ApiFailure here instead of ending the request
const MCP_VERSION = '1.0.0';
const MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function rpc_send($payload, int $http = 200): void
{
    http_response_code($http);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}
function rpc_error($id, int $code, string $msg, int $http = 200, $data = null): void
{
    $e = ['code' => $code, 'message' => $msg];
    if ($data !== null) $e['data'] = $data;
    rpc_send(['jsonrpc' => '2.0', 'id' => $id, 'error' => $e], $http);
}

function bearer_token(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('getallheaders')) foreach (getallheaders() as $k => $v) if (strtolower($k) === 'authorization') $h = $v;
    if (preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) return $m[1];
    return trim((string)($_SERVER['HTTP_X_API_KEY'] ?? ''));
}


/* ---------------- request handling ---------------- */
$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') { http_response_code(204); header('Allow: POST, OPTIONS'); exit; }
if ($method !== 'POST') { header('Allow: POST, OPTIONS'); rpc_send(['error' => 'This is an MCP endpoint. Send JSON-RPC 2.0 requests with HTTP POST.'], 405); }

try {
    config();
    ensure_schema();
    $ip = client_ip();
    $tok = bearer_token();
    if ($tok === '' || strlen($tok) > 200) {
        header('WWW-Authenticate: Bearer realm="Infraura Quotation Builder MCP"');
        rpc_error(null, -32001, 'Authentication required. Send "Authorization: Bearer <token>" (create a token in Settings > AI assistants).', 401);
    }
    $tr = q('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0', [hash('sha256', $tok)])->fetch();
    if (!$tr || ($tr['expires_at'] && $tr['expires_at'] < now())) {
        rate_limit('mcpauth:' . $ip, 30, 600);   // throttle token guessing
        header('WWW-Authenticate: Bearer realm="Infraura Quotation Builder MCP", error="invalid_token"');
        rpc_error(null, -32001, 'Invalid, expired or revoked token.', 401);
    }
    rate_limit('mcp:' . $tr['id'], 120, 60);
    if (!$tr['last_used_at'] || strtotime((string)$tr['last_used_at']) < time() - 60) q('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now(), $tr['id']]);
    $owner = $tr['user_id'] ? q('SELECT id,name,email,role FROM users WHERE id = ?', [(int)$tr['user_id']])->fetch() : null;
    $GLOBALS['MCP_TOKEN'] = $tr;
    $GLOBALS['MCP_USER'] = ['id' => $owner ? (int)$owner['id'] : null, 'name' => 'AI: ' . $tr['name'], 'email' => $owner['email'] ?? '', 'role' => 'staff'];

    $raw = file_get_contents('php://input');
    if (strlen((string)$raw) > 1048576) rpc_error(null, -32600, 'Request too large', 413);
    $msg = json_decode((string)$raw, true);
    if (!is_array($msg)) rpc_error(null, -32700, 'Parse error: body must be JSON', 400);

    $isBatch = array_is_list($msg) && $msg !== [];
    $batch = $isBatch ? $msg : [$msg];
    if (count($batch) > 20) rpc_error(null, -32600, 'Batch too large (max 20)', 400);
    $responses = [];
    foreach ($batch as $one) {
        $r = mcp_dispatch(is_array($one) ? $one : []);
        if ($r !== null) $responses[] = $r;
    }
    if (!$responses) { http_response_code(202); exit; }         // only notifications / responses were sent
    rpc_send($isBatch ? $responses : $responses[0]);
} catch (ApiFailure $e) {
    rpc_error(null, -32603, $e->getMessage(), $e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 500);
} catch (Throwable $e) {
    error_log('MCP error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    app_log_error('MCP error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    rpc_error(null, -32603, 'Internal server error', 500);
}

function mcp_dispatch(array $m): ?array
{
    $id = $m['id'] ?? null;
    $has = array_key_exists('id', $m);
    $method = $m['method'] ?? null;
    if (($m['jsonrpc'] ?? '') !== '2.0' || !is_string($method)) {
        if (isset($m['result']) || isset($m['error'])) return null;     // a client response to us: ignore
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32600, 'message' => 'Invalid JSON-RPC request']];
    }
    if (!$has) return null;                                              // notification (e.g. notifications/initialized)
    $params = is_array($m['params'] ?? null) ? $m['params'] : [];
    try {
        switch ($method) {
            case 'initialize':
                $want = (string)($params['protocolVersion'] ?? '');
                $ver = in_array($want, MCP_PROTOCOLS, true) ? $want : MCP_PROTOCOLS[0];
                return rpc_ok($id, [
                    'protocolVersion' => $ver,
                    'capabilities' => ['tools' => ['listChanged' => false], 'prompts' => ['listChanged' => false]],
                    'serverInfo' => ['name' => 'infraura-quotation-builder', 'title' => 'Infraura Quotation Builder', 'version' => MCP_VERSION],
                    'instructions' => "Quotation, rate-card and project data for Infraura (Sheet Roofing, Interior, Construction, PMC). All money is in INR. "
                        . "For a roofing quote request use create_roofing_quote (A-type / A-frame / pitched = gable). State your assumptions (frame included? gutters?) back to the user, and ask for the client name if it was not given. Use search_rate_card to find real items and rates before drafting other work; use calculate_roof to compare roofing materials. "
                        . "Write tools only create or edit DRAFT quotes - a human reviews and sends them from the app. You cannot send, accept, delete or change settings.",
                ]);
            case 'ping': return rpc_ok($id, new stdClass());
            case 'tools/list':
                $list = [];
                foreach (mcp_tools() as $tn => $t) $list[] = ['name' => $tn] + array_diff_key($t, ['scope' => 1, 'run' => 1]);
                return rpc_ok($id, ['tools' => $list]);
            case 'tools/call': return rpc_ok($id, mcp_call_tool((string)($params['name'] ?? ''), is_array($params['arguments'] ?? null) ? $params['arguments'] : []));
            case 'prompts/list': return rpc_ok($id, ['prompts' => mcp_prompt_list()]);
            case 'prompts/get': return rpc_ok($id, mcp_prompt_get((string)($params['name'] ?? ''), is_array($params['arguments'] ?? null) ? $params['arguments'] : []));
            case 'resources/list': return rpc_ok($id, ['resources' => []]);
            case 'resources/templates/list': return rpc_ok($id, ['resourceTemplates' => []]);
            case 'logging/setLevel': return rpc_ok($id, new stdClass());
            default: return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32601, 'message' => 'Method not found: ' . $method]];
        }
    } catch (ApiFailure $e) {
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32602, 'message' => $e->getMessage()]];
    }
}
function rpc_ok($id, $result): array { return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]; }

/* ---------------- helpers for tools ---------------- */
function mcp_can_write(): bool { return $GLOBALS['MCP_TOKEN']['scope'] === 'write'; }
function mcp_hide_costs(): bool { return (int)$GLOBALS['MCP_TOKEN']['hide_costs'] === 1; }

function strip_internal($v)
{ // remove cost / margin data when the token is not allowed to see it
    if (!is_array($v)) return $v;
    $out = [];
    foreach ($v as $k => $x) {
        if (is_string($k) && in_array($k, ['cost', 'margin', 'margin_pct', 'internal_cost', 'cost_total', 'roofcalc', 'pmc'], true)) continue;
        $out[$k] = strip_internal($x);
    }
    return $out;
}
function tool_result(array $data, bool $isError = false): array
{
    if (mcp_hide_costs()) $data = strip_internal($data);
    $structured = array_is_list($data) && $data !== [] ? ['items' => $data] : (array_is_list($data) ? new stdClass() : $data);
    return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION)]],
        'structuredContent' => $structured, 'isError' => $isError];
}
function tool_error(string $msg): array
{
    return ['content' => [['type' => 'text', 'text' => $msg]], 'isError' => true];
}
function a_str(array $a, string $k, int $max = 255): string { return str($a[$k] ?? '', $max); }
function a_int(array $a, string $k, int $def, int $min, int $max): int { return isset($a[$k]) && is_numeric($a[$k]) ? max($min, min($max, (int)$a[$k])) : $def; }

function mcp_call_tool(string $name, array $args): array
{
    $tools = mcp_tools();
    if (!isset($tools[$name])) throw new ApiFailure('Unknown tool: ' . $name);
    $t = $tools[$name];
    if ($t['scope'] === 'write' && !mcp_can_write()) return tool_error('This token is read-only, so "' . $name . '" is not permitted. An admin can create a read & write token in Settings > AI assistants.');
    try {
        $res = ($t['run'])($args);
        if ($t['scope'] === 'write') audit($GLOBALS['MCP_USER'], 'mcp.' . $name, mb_substr(json_encode($args, JSON_UNESCAPED_UNICODE), 0, 300));
        return tool_result($res);
    } catch (ApiFailure $e) {
        return tool_error($e->getMessage());
    } catch (PDOException $e) {
        error_log('MCP tool DB error: ' . $e->getMessage());
        return tool_error('A database error occurred. Please try again.');
    }
}

function quote_view(array $row): array
{
    $d = json_decode((string)$row['data'], true) ?: [];
    $client = json_decode((string)$row['client_json'], true) ?: [];
    $t = ['subtotal' => (float)$row['subtotal'], 'discount' => (float)$row['discount'], 'gst' => (float)$row['tax'], 'round_off' => (float)$row['round_off'], 'total' => (float)$row['total']];
    $secs = function (array $ss): array {
        return array_map(function ($s) {
            return ['section' => $s['title'] ?? '', 'lines' => array_map(fn($i) => ['description' => $i['desc'] ?? '', 'unit' => $i['unit'] ?? '', 'quantity' => (float)($i['qty'] ?? 0), 'rate' => (float)($i['rate'] ?? 0), 'amount' => money((float)($i['qty'] ?? 0) * (float)($i['rate'] ?? 0)), 'cost' => (float)($i['cost'] ?? 0)], $s['items'] ?? [])];
        }, $ss);
    };
    $events = q("SELECT type, COUNT(*) AS n, MAX(created_at) AS last FROM quote_events WHERE quote_no = ? GROUP BY type", [$row['quote_no']])->fetchAll();
    $act = []; foreach ($events as $e) $act[$e['type']] = ['count' => (int)$e['n'], 'last' => $e['last']];
    [$rev, $cost] = quote_margin($d);
    $pay = array_map(fn($p) => ['stage' => $p['label'], 'percent' => (float)$p['percent'], 'amount' => money($t['total'] * (float)$p['percent'] / 100)], $d['payment_schedule'] ?? []);
    $proj = q('SELECT id FROM projects WHERE quote_no = ?', [$row['quote_no']])->fetch();
    return [
        'quote_id' => (int)$row['id'], 'quote_no' => $row['quote_no'], 'revision' => (int)$row['rev'], 'is_latest' => (bool)$row['is_latest'], 'status' => $row['status'], 'division' => $row['division'],
        'client' => $client, 'title' => $row['title'], 'quote_date' => $row['quote_date'], 'valid_until' => $row['valid_until'], 'site_address' => $d['site_address'] ?? '', 'area_sqft' => $d['area_sqft'] ?? 0,
        'scope' => $d['scope'] ?? '', 'sections' => $secs($d['sections'] ?? []),
        'options' => array_map(fn($o) => ['name' => $o['name'], 'note' => $o['note'], 'sections' => $secs($o['sections'] ?? [])], $d['options'] ?? []), 'selected_option' => $d['selected_option'] ?? 0,
        'discount' => $d['discount'] ?? null, 'gst_percent' => $d['tax_rate'] ?? 18, 'gst_mode' => $d['gst_mode'] ?? '', 'hsn_sac' => $d['hsn'] ?? '', 'totals' => $t,
        'payment_schedule' => $pay, 'terms' => $d['terms'] ?? [], 'notes' => $d['notes'] ?? '', 'lead_source' => $d['source'] ?? '',
        'client_activity' => $act, 'project_id' => $proj ? (int)$proj['id'] : null,
        'margin_pct' => $rev > 0 ? round(($rev - $cost) / $rev * 100, 1) : null, 'internal_cost_total' => round($cost, 2),
        'app_url' => app_base_url() . '/index.html#/quotes/' . (int)$row['id'], 'updated_at' => $row['updated_at'],
    ];
}

function find_quote(array $a): array
{
    if (!empty($a['quote_id'])) $row = q('SELECT * FROM quotes WHERE id = ?', [(int)$a['quote_id']])->fetch();
    elseif (!empty($a['quote_no'])) $row = q('SELECT * FROM quotes WHERE quote_no = ? AND is_latest = 1', [a_str($a, 'quote_no', 40)])->fetch();
    else fail('Provide quote_id or quote_no');
    if (!$row) fail('Quote not found');
    return $row;
}

/** Turn simple AI-friendly "lines" into the app's sections structure. */
function lines_to_sections(array $lines, string $division): array
{
    if (!$lines) fail('Provide at least one line');
    if (count($lines) > 300) fail('Too many lines (max 300 per call)');
    $default = ['roofing' => 'Roofing Works', 'interior' => 'Interior Works', 'construction' => 'Construction Works', 'pmc' => 'PMC Services'][$division] ?? 'Works';
    $sections = []; $order = [];
    foreach ($lines as $i => $l) {
        if (!is_array($l)) fail('Each line must be an object (line ' . ($i + 1) . ')');
        $item = null;
        if (!empty($l['rate_item_id'])) {
            $r = q('SELECT * FROM rate_items WHERE id = ? AND active = 1', [(int)$l['rate_item_id']])->fetch();
            if (!$r) fail('Line ' . ($i + 1) . ': rate_item_id ' . (int)$l['rate_item_id'] . ' not found (use search_rate_card)');
            $item = ['desc' => trim((string)($l['description'] ?? '')) !== '' ? $l['description'] : $r['name'], 'unit' => $r['unit'], 'qty' => $l['quantity'] ?? 1, 'rate' => $l['rate'] ?? $r['rate'], 'cost' => $r['cost']];
        } else {
            foreach (['description', 'unit', 'quantity', 'rate'] as $need) if (!isset($l[$need]) || $l[$need] === '') fail('Line ' . ($i + 1) . ': "' . $need . '" is required when rate_item_id is not given');
            $item = ['desc' => $l['description'], 'unit' => $l['unit'], 'qty' => $l['quantity'], 'rate' => $l['rate'], 'cost' => $l['cost'] ?? 0];
        }
        if (!is_numeric($item['qty']) || !is_numeric($item['rate'])) fail('Line ' . ($i + 1) . ': quantity and rate must be numbers');
        $title = trim((string)($l['section'] ?? '')) ?: $default;
        if (!isset($sections[$title])) { $sections[$title] = []; $order[] = $title; }
        $sections[$title][] = $item;
    }
    return array_map(fn($t) => ['title' => $t, 'items' => $sections[$t], 'images' => []], $order);
}

function build_quote_input(array $a, string $division): array
{
    $gst = isset($a['gst_percent']) && is_numeric($a['gst_percent']) ? (float)$a['gst_percent'] : (float)(get_setting('gst_' . $division) ?: 18);
    $sched = [];
    if (isset($a['payment_schedule']) && is_array($a['payment_schedule'])) { foreach ($a['payment_schedule'] as $p) if (is_array($p)) $sched[] = ['label' => (string)($p['stage'] ?? $p['label'] ?? ''), 'percent' => (float)($p['percent'] ?? 0)]; }
    else foreach (preg_split('/\R/', (string)get_setting('pay_' . $division)) as $line) { if (strpos($line, '|') !== false) { [$l, $p] = explode('|', $line, 2); $sched[] = ['label' => trim($l), 'percent' => (float)$p]; } }
    $terms = isset($a['terms']) && is_array($a['terms']) ? array_map('strval', $a['terms']) : array_values(array_filter(array_map('trim', preg_split('/\R/', (string)get_setting('terms_' . $division)))));
    $discount = ['type' => 'percent', 'value' => 0];
    if (isset($a['discount_flat']) && is_numeric($a['discount_flat'])) $discount = ['type' => 'flat', 'value' => (float)$a['discount_flat']];
    elseif (isset($a['discount_percent']) && is_numeric($a['discount_percent'])) $discount = ['type' => 'percent', 'value' => (float)$a['discount_percent']];
    return [
        'sections' => isset($a['lines']) && is_array($a['lines']) ? lines_to_sections($a['lines'], $division) : [], 'discount' => $discount, 'tax_rate' => $gst, 'round_off' => !empty($a['round_off']),
        'payment_schedule' => $sched, 'terms' => $terms, 'notes' => a_str($a, 'notes', 3000), 'scope' => a_str($a, 'scope', 3000), 'site_address' => a_str($a, 'site_address', 500),
        'area_sqft' => isset($a['area_sqft']) && is_numeric($a['area_sqft']) ? (float)$a['area_sqft'] : 0, 'hsn' => (string)(get_setting('hsn_' . $division) ?? ''), 'source' => 'AI assistant (MCP)',
    ];
}

/* ---------------- tool catalogue ---------------- */
function mcp_tools(): array
{
    static $tools = null;
    if ($tools !== null) return $tools;
    $div = ['type' => 'string', 'enum' => ['roofing', 'interior', 'construction', 'pmc'], 'description' => 'Business division: roofing = Sheet Roofing (GI, UPVC, PUF, aluminium...), interior, construction, pmc = project management consultancy'];
    $ro = ['readOnlyHint' => true, 'destructiveHint' => false, 'idempotentHint' => true, 'openWorldHint' => false];
    $wr = ['readOnlyHint' => false, 'destructiveHint' => false, 'idempotentHint' => false, 'openWorldHint' => false];
    $lineSchema = ['type' => 'object', 'properties' => [
        'rate_item_id' => ['type' => 'integer', 'description' => 'ID from search_rate_card (fills description, unit, rate). Preferred.'],
        'description' => ['type' => 'string', 'description' => 'Required for custom lines; optional override when rate_item_id is used'],
        'unit' => ['type' => 'string', 'description' => 'e.g. sq ft, rft, nos, kg, lot (custom lines)'], 'quantity' => ['type' => 'number', 'minimum' => 0],
        'rate' => ['type' => 'number', 'minimum' => 0, 'description' => 'INR per unit, excluding GST. Optional with rate_item_id (overrides the rate-card rate).'],
        'section' => ['type' => 'string', 'description' => 'Group heading, e.g. "Kitchen" or "Roofing Works". Lines with the same section are grouped.'],
    ], 'required' => ['quantity']];
    $draftProps = [
        'title' => ['type' => 'string', 'description' => 'Project name, e.g. "Warehouse roofing - Phase 1"'], 'site_address' => ['type' => 'string'], 'area_sqft' => ['type' => 'number'],
        'scope' => ['type' => 'string', 'description' => 'Scope of work paragraph printed above the items'], 'notes' => ['type' => 'string'],
        'lines' => ['type' => 'array', 'items' => $lineSchema, 'description' => 'Quote line items'],
        'discount_percent' => ['type' => 'number', 'minimum' => 0, 'maximum' => 100], 'discount_flat' => ['type' => 'number', 'minimum' => 0],
        'gst_percent' => ['type' => 'number', 'description' => 'Defaults to the division GST rate in Settings (usually 18)'], 'round_off' => ['type' => 'boolean'],
        'payment_schedule' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['stage' => ['type' => 'string'], 'percent' => ['type' => 'number']], 'required' => ['stage', 'percent']], 'description' => 'Must total 100%. Defaults to the division schedule in Settings.'],
        'terms' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Defaults to the division terms in Settings'],
    ];
    $clientObj = ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'contact_person' => ['type' => 'string'], 'phone' => ['type' => 'string'], 'email' => ['type' => 'string'], 'address' => ['type' => 'string'], 'gstin' => ['type' => 'string']], 'required' => ['name']];

    $T = [];
    $T['get_business_overview'] = ['scope' => 'read', 'title' => 'Business overview', 'description' => 'Pipeline value by status and division, recent quotes, quotes needing follow-up (sent 3+ days ago), client count and receivables (contract value, collected, outstanding, overdue milestones). Start here for "how are we doing" questions.',
        'inputSchema' => ['type' => 'object', 'properties' => new stdClass()], 'annotations' => $ro, 'run' => function (array $a) { $d = dashboard(); unset($d['monthly']); return $d; }];
    $T['search_quotes'] = ['scope' => 'read', 'title' => 'Search quotes', 'description' => 'Find quotations (latest revision of each). Filter by free text (quote number, client, project), status and division. Returns summary rows; use get_quote for full detail.',
        'inputSchema' => ['type' => 'object', 'properties' => ['query' => ['type' => 'string'], 'status' => ['type' => 'string', 'enum' => ['draft', 'sent', 'accepted', 'rejected']], 'division' => $div, 'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50, 'default' => 20]]],
        'annotations' => $ro, 'run' => function (array $a) {
            $w = ['is_latest = 1']; $p = [];
            if (!empty($a['status']) && in_array($a['status'], STATUSES, true)) { $w[] = 'status = ?'; $p[] = $a['status']; }
            if (!empty($a['division']) && isset(DIVISIONS[$a['division']])) { $w[] = 'division = ?'; $p[] = $a['division']; }
            if (!empty($a['query'])) { $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], a_str($a, 'query', 100)) . '%'; $w[] = '(quote_no LIKE ? OR title LIKE ? OR client_json LIKE ?)'; array_push($p, $like, $like, $like); }
            $rows = q('SELECT id,quote_no,rev,division,client_json,title,status,quote_date,valid_until,total FROM quotes WHERE ' . implode(' AND ', $w) . ' ORDER BY id DESC LIMIT ' . a_int($a, 'limit', 20, 1, 50), $p)->fetchAll();
            return array_map(fn($r) => ['quote_id' => (int)$r['id'], 'quote_no' => $r['quote_no'], 'revision' => (int)$r['rev'], 'division' => $r['division'], 'client' => (json_decode((string)$r['client_json'], true) ?: [])['name'] ?? '', 'title' => $r['title'], 'status' => $r['status'], 'quote_date' => $r['quote_date'], 'valid_until' => $r['valid_until'], 'total' => (float)$r['total']], $rows);
        }];
    $T['get_quote'] = ['scope' => 'read', 'title' => 'Get quote', 'description' => 'Full detail of one quotation: client, sections and lines with amounts, options, GST and totals, payment schedule, terms, client activity (views / acceptance), linked project, and a link to open it in the app.',
        'inputSchema' => ['type' => 'object', 'properties' => ['quote_id' => ['type' => 'integer'], 'quote_no' => ['type' => 'string', 'description' => 'e.g. INF/RF/26-27/0001 (returns the latest revision)']]],
        'annotations' => $ro, 'run' => fn(array $a) => quote_view(find_quote($a))];
    $T['calculate_quote_totals'] = ['scope' => 'read', 'title' => 'Calculate quote totals', 'description' => 'Pure calculator (saves nothing): subtotal, discount, GST, round-off and grand total for a list of quantity x rate lines, using the same rounding as the app.',
        'inputSchema' => ['type' => 'object', 'properties' => ['lines' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['quantity' => ['type' => 'number'], 'rate' => ['type' => 'number']], 'required' => ['quantity', 'rate']]], 'discount_percent' => ['type' => 'number'], 'discount_flat' => ['type' => 'number'], 'gst_percent' => ['type' => 'number', 'default' => 18], 'round_off' => ['type' => 'boolean']], 'required' => ['lines']],
        'annotations' => $ro, 'run' => function (array $a) {
            $items = []; foreach (($a['lines'] ?? []) as $l) if (is_array($l)) $items[] = ['qty' => check_amount(num($l['quantity'] ?? 0)), 'rate' => check_amount(num($l['rate'] ?? 0))];
            if (!$items) fail('Provide at least one line');
            $disc = isset($a['discount_flat']) ? ['type' => 'flat', 'value' => num($a['discount_flat'])] : ['type' => 'percent', 'value' => num($a['discount_percent'] ?? 0)];
            [$sub, $d, $tax, $ro, $total] = compute_totals(['sections' => [['items' => $items]], 'discount' => $disc, 'tax_rate' => isset($a['gst_percent']) ? num($a['gst_percent']) : 18, 'round_off' => !empty($a['round_off'])]);
            return ['subtotal' => $sub, 'discount' => $d, 'taxable' => money($sub - $d), 'gst' => $tax, 'round_off' => $ro, 'grand_total' => $total, 'amount_in_words_hint' => 'INR ' . number_format($total, 2)];
        }];
    $T['list_clients'] = ['scope' => 'read', 'title' => 'List clients', 'description' => 'Search the client book by name, phone, email or GSTIN.',
        'inputSchema' => ['type' => 'object', 'properties' => ['query' => ['type' => 'string'], 'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50, 'default' => 20]]],
        'annotations' => $ro, 'run' => function (array $a) {
            $p = []; $w = '';
            if (!empty($a['query'])) { $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], a_str($a, 'query', 100)) . '%'; $w = ' WHERE c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.gstin LIKE ? OR c.contact_person LIKE ?'; $p = [$like, $like, $like, $like, $like]; }
            return array_map(function ($r) { $r['client_id'] = (int)$r['id']; unset($r['id']); $r['quote_count'] = (int)$r['quote_count']; return $r; },
                q('SELECT c.id,c.name,c.contact_person,c.phone,c.email,c.address,c.gstin,(SELECT COUNT(*) FROM quotes x WHERE x.client_id = c.id AND x.is_latest = 1) AS quote_count FROM clients c' . $w . ' ORDER BY c.name LIMIT ' . a_int($a, 'limit', 20, 1, 50), $p)->fetchAll());
        }];
    $T['search_rate_card'] = ['scope' => 'read', 'title' => 'Search rate card', 'description' => 'Search the priced item catalogue (rate cards) by words in the item name or category. Always use this to find real items, units and rates before drafting a quote. Returns rate_item_id for create_quote_draft.',
        'inputSchema' => ['type' => 'object', 'properties' => ['query' => ['type' => 'string', 'description' => 'e.g. "PUF 50 mm", "gypsum false ceiling", "TMT"'], 'division' => $div, 'category' => ['type' => 'string'], 'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100, 'default' => 25]]],
        'annotations' => $ro, 'run' => function (array $a) {
            $w = ['active = 1']; $p = [];
            if (!empty($a['division']) && isset(DIVISIONS[$a['division']])) { $w[] = 'division = ?'; $p[] = $a['division']; }
            if (!empty($a['category'])) { $w[] = 'category LIKE ?'; $p[] = '%' . a_str($a, 'category', 100) . '%'; }
            foreach (preg_split('/\s+/', trim(a_str($a, 'query', 150))) as $word) if ($word !== '') { $w[] = '(name LIKE ? OR category LIKE ?)'; $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $word) . '%'; array_push($p, $like, $like); }
            return array_map(fn($r) => ['rate_item_id' => (int)$r['id'], 'division' => $r['division'], 'category' => $r['category'], 'name' => $r['name'], 'unit' => $r['unit'], 'rate' => (float)$r['rate'], 'cost' => (float)$r['cost'], 'note' => $r['description']],
                q('SELECT id,division,category,name,unit,rate,cost,description FROM rate_items WHERE ' . implode(' AND ', $w) . ' ORDER BY division, category, name LIMIT ' . a_int($a, 'limit', 25, 1, 100), $p)->fetchAll());
        }];
    $T['calculate_roof'] = ['scope' => 'read', 'title' => 'Roofing calculator', 'description' => 'Roof geometry and priced packages for sheet roofing. Gives roof area (with slope), wastage, purlin/frame steel, flashings, gutters, screws and ventilators, then a complete priced line list for each requested material (GI, UPVC, PUF, aluminium...) using the current rate card, so materials can be compared. Pass a package\'s "lines" straight into create_quote_draft. Estimates only - verify on site.',
        'inputSchema' => ['type' => 'object', 'properties' => [
            'roof_type' => ['type' => 'string', 'enum' => ['gable', 'shed', 'flat'], 'default' => 'gable'], 'length_ft' => ['type' => 'number', 'description' => 'Building length (along the ridge), feet'], 'width_ft' => ['type' => 'number', 'description' => 'Building width / span, feet'],
            'slope_degrees' => ['type' => 'number', 'default' => 10], 'eave_overhang_ft' => ['type' => 'number', 'default' => 1], 'gable_overhang_ft' => ['type' => 'number', 'default' => 0.5], 'eave_height_ft' => ['type' => 'number', 'default' => 12, 'description' => 'For downpipe length'],
            'wastage_percent' => ['type' => 'number', 'default' => 7], 'skylight_percent' => ['type' => 'number', 'default' => 0], 'include_gutters' => ['type' => 'boolean', 'default' => true], 'include_structure' => ['type' => 'boolean', 'default' => true, 'description' => 'false = sheeting/flashings only (re-roofing on an existing frame): leaves out the steel frame and purlins'],
            'materials' => ['type' => 'array', 'items' => ['type' => 'string', 'enum' => array_keys(ROOF_MATS)], 'description' => 'Defaults to gi, upvc, puf50, alu. ' . implode('; ', array_map(fn($k, $v) => "$k = {$v['label']}", array_keys(ROOF_MATS), ROOF_MATS))]], 'required' => ['length_ft', 'width_ft']],
        'annotations' => $ro, 'run' => function (array $a) {
            $in = ['type' => $a['roof_type'] ?? 'gable', 'len' => $a['length_ft'] ?? 0, 'wid' => $a['width_ft'] ?? 0, 'slope' => $a['slope_degrees'] ?? null, 'eave' => $a['eave_overhang_ft'] ?? null, 'gable' => $a['gable_overhang_ft'] ?? null,
                'height' => $a['eave_height_ft'] ?? null, 'waste' => $a['wastage_percent'] ?? null, 'sky' => $a['skylight_percent'] ?? null, 'gutter' => array_key_exists('include_gutters', $a) && !$a['include_gutters'] ? 'no' : 'yes', 'structure' => array_key_exists('include_structure', $a) && !$a['include_structure'] ? 'no' : 'yes'];
            foreach (['len', 'wid'] as $k) if (!is_numeric($in[$k]) || (float)$in[$k] <= 0 || (float)$in[$k] > 5000) fail('length_ft and width_ft must be positive numbers (max 5000)');
            $mats = isset($a['materials']) && is_array($a['materials']) && $a['materials'] ? array_values(array_unique(array_map('strval', $a['materials']))) : ['gi', 'upvc', 'puf50', 'alu'];
            foreach ($mats as $m) if (!isset(ROOF_MATS[$m])) fail('Unknown material "' . $m . '". Valid: ' . implode(', ', array_keys(ROOF_MATS)));
            $r = roof_calc($in, $mats, roof_rates_from_db());
            $gst = (float)(get_setting('gst_roofing') ?: 18);
            foreach ($r['packages'] as &$p) {
                $p['gst_percent'] = $gst; $p['total_incl_gst'] = money($p['total_before_gst'] * (1 + $gst / 100));
                $p['lines'] = array_map(fn($l) => ['section' => 'Roofing - ' . $p['label'], 'description' => $l['desc'], 'unit' => $l['unit'], 'quantity' => $l['qty'], 'rate' => $l['rate'], 'cost' => $l['cost']], $p['lines']);
            }
            $r['note'] = 'Quantities are estimates from roof geometry; rates come from the rate card. Pass a package\'s lines to create_quote_draft.';
            return $r;
        }];
    $T['create_roofing_quote'] = ['scope' => 'write', 'title' => 'Create roofing quote (one step)', 'description' => 'ONE-STEP sheet-roofing quotation. Calculates the roof (sloped area, wastage, steel frame and purlins, flashings, gutters, fasteners, ventilators), prices every line from the rate card and saves a DRAFT quote. Use this when a user asks for a roofing quote with a size and a material, e.g. "GI sheet roofing for a 60 x 30 ft A-type shed". roof_type: "gable" = A-type / A-frame / double-slope / pitched roof (the common one, default); "shed" = mono-slope / lean-to; "flat". material: gi (GI colour-coated 0.40 mm, default), gi55, galv, upvc, upvcasa, puf30, puf50, puf75, alu, poly. Give SEVERAL materials to create one quote with selectable options the client can choose between. If the client is not known the draft is saved under "Client to be confirmed" - tell the user to set the client. The quote is a draft: a person reviews it in the app (app_url) and sends it.',
        'inputSchema' => ['type' => 'object', 'properties' => [
            'length_ft' => ['type' => 'number', 'description' => 'Building length along the ridge, feet'], 'width_ft' => ['type' => 'number', 'description' => 'Building width / span, feet'],
            'material' => ['type' => 'string', 'enum' => array_keys(ROOF_MATS), 'default' => 'gi'], 'materials' => ['type' => 'array', 'items' => ['type' => 'string', 'enum' => array_keys(ROOF_MATS)], 'description' => 'Optional: 2-4 materials to offer as options (overrides material)'],
            'roof_type' => ['type' => 'string', 'enum' => ['gable', 'shed', 'flat'], 'default' => 'gable'], 'slope_degrees' => ['type' => 'number', 'default' => 10], 'eave_overhang_ft' => ['type' => 'number', 'default' => 1], 'gable_overhang_ft' => ['type' => 'number', 'default' => 0.5],
            'eave_height_ft' => ['type' => 'number', 'default' => 12], 'wastage_percent' => ['type' => 'number', 'default' => 7], 'skylight_percent' => ['type' => 'number', 'default' => 0], 'include_gutters' => ['type' => 'boolean', 'default' => true], 'include_structure' => ['type' => 'boolean', 'default' => true, 'description' => 'true (default) = new building: includes the MS steel frame/trusses and purlins. false = sheeting, flashings, gutters and fasteners only (re-roofing an existing frame). If the user did not say which, assume true and tell them.'],
            'client_id' => ['type' => 'integer'], 'client' => $clientObj, 'title' => ['type' => 'string'], 'site_address' => ['type' => 'string'], 'notes' => ['type' => 'string'],
            'discount_percent' => ['type' => 'number', 'minimum' => 0, 'maximum' => 100], 'gst_percent' => ['type' => 'number']], 'required' => ['length_ft', 'width_ft']],
        'annotations' => $wr, 'run' => function (array $a) {
            foreach (['length_ft', 'width_ft'] as $k) if (!isset($a[$k]) || !is_numeric($a[$k]) || (float)$a[$k] <= 0 || (float)$a[$k] > 5000) fail($k . ' must be a positive number of feet (max 5000)');
            $mats = isset($a['materials']) && is_array($a['materials']) && $a['materials'] ? array_values(array_unique(array_map('strval', $a['materials']))) : [(string)($a['material'] ?? 'gi')];
            if (count($mats) > 4) fail('Offer at most 4 materials in one quote');
            foreach ($mats as $m) if (!isset(ROOF_MATS[$m])) fail('Unknown material "' . $m . '". Valid: ' . implode(', ', array_keys(ROOF_MATS)));
            $type = (string)($a['roof_type'] ?? 'gable'); if (!in_array($type, ['gable', 'shed', 'flat'], true)) fail('roof_type must be gable (A-type), shed or flat');
            $in = ['type' => $type, 'len' => $a['length_ft'], 'wid' => $a['width_ft'], 'slope' => $a['slope_degrees'] ?? null, 'eave' => $a['eave_overhang_ft'] ?? null, 'gable' => $a['gable_overhang_ft'] ?? null, 'height' => $a['eave_height_ft'] ?? null,
                'waste' => $a['wastage_percent'] ?? null, 'sky' => $a['skylight_percent'] ?? null, 'gutter' => array_key_exists('include_gutters', $a) && !$a['include_gutters'] ? 'no' : 'yes', 'structure' => array_key_exists('include_structure', $a) && !$a['include_structure'] ? 'no' : 'yes'];
            $calc = roof_calc($in, $mats, roof_rates_from_db());
            if (!$calc) fail('Could not calculate this roof');
            $warnings = [];
            $assume = ['Roof type: ' . ['gable' => 'A-type / gable (two slopes)', 'shed' => 'mono-slope', 'flat' => 'flat'][$type] . ', slope ' . ($calc['inputs']['slope'] + 0) . ' degrees, eave overhang ' . ($calc['inputs']['eave'] + 0) . ' ft, ' . ($calc['inputs']['waste'] + 0) . '% wastage', $in['structure'] === 'yes' ? 'Includes the MS steel frame and purlins (new building). Re-quote with include_structure=false for sheeting only.' : 'Sheeting, flashings and fasteners only - NO steel frame or purlins (existing frame assumed).', $in['gutter'] === 'yes' ? 'Includes gutters and downpipes.' : 'Gutters and downpipes excluded.', 'Rates are from the current rate card; quantities are estimates to be confirmed on site.'];
            // client: given id / given details / shared placeholder
            if (!empty($a['client_id'])) { $cl = q('SELECT * FROM clients WHERE id = ?', [(int)$a['client_id']])->fetch(); if (!$cl) fail('client_id not found'); }
            elseif (!empty($a['client']['name'] ?? '')) { $cl = null; }
            else {
                $cl = q('SELECT * FROM clients WHERE name = ?', ['Client to be confirmed'])->fetch();
                if (!$cl) { q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', ['Client to be confirmed', '', '', '', '', '', now()]); $cl = q('SELECT * FROM clients WHERE id = ?', [(int)db()->lastInsertId()])->fetch(); }
                $warnings[] = 'No client was given, so the draft is under "Client to be confirmed". Open it in the app and choose the client before sending.';
            }
            $clientArr = $cl ? ['name' => $cl['name'], 'contact_person' => $cl['contact_person'], 'phone' => $cl['phone'], 'email' => $cl['email'], 'address' => $cl['address'], 'gstin' => $cl['gstin']] : (is_array($a['client'] ?? null) ? $a['client'] : []);
            $g = $calc['geometry']; $L = money((float)$a['length_ft']); $W = money((float)$a['width_ft']);
            $typeTxt = ['gable' => 'A-type (gable)', 'shed' => 'mono-slope', 'flat' => 'flat'][$type];
            $toItems = fn(array $pkg) => array_map(fn($l) => ['desc' => $l['desc'], 'unit' => $l['unit'], 'qty' => $l['qty'], 'rate' => $l['rate'], 'cost' => $l['cost']], $pkg['lines']);
            $data = build_quote_input(['gst_percent' => $a['gst_percent'] ?? null, 'discount_percent' => $a['discount_percent'] ?? null, 'notes' => $a['notes'] ?? '', 'site_address' => $a['site_address'] ?? ''], 'roofing');
            $data['area_sqft'] = round($g['plan']);
            $data['scope'] = 'Supply and installation of ' . (count($mats) > 1 ? 'roof sheeting (options below)' : ROOF_MATS[$mats[0]]['label'] . ' roof sheeting') . " for a {$L} x {$W} ft {$typeTxt} building (roof area approx. " . roof_in_words($g['area']) . ' sq ft including slope), with ' . ($in['structure'] === 'yes' ? 'supporting steel structure, ' : '') . 'flashings' . (($in['gutter'] === 'yes') ? ', gutters and downpipes' : '') . ' and fasteners.';
            if (count($mats) === 1) $data['sections'] = [['title' => 'Roofing - ' . ROOF_MATS[$mats[0]]['label'], 'items' => $toItems($calc['packages'][0]), 'images' => []]];
            else { $data['sections'] = []; $data['options'] = array_map(fn($p) => ['name' => ROOF_MATS[$p['material']]['short'], 'note' => $p['label'], 'sections' => [['title' => 'Roofing - ' . $p['label'], 'items' => $toItems($p), 'images' => []]]], $calc['packages']); $data['selected_option'] = 0; }
            $title = a_str($a, 'title') ?: ('Roofing - ' . $L . ' x ' . $W . ' ft ' . $typeTxt . ' - ' . implode(' / ', array_map(fn($p) => $p['label'], $calc['packages'])));
            $r = create_quote($GLOBALS['MCP_USER'], ['division' => 'roofing', 'client_id' => $cl ? (int)$cl['id'] : null, 'client' => $clientArr, 'title' => mb_substr($title, 0, 250), 'data' => $data]);
            $out = ['quote_id' => $r['id'], 'quote_no' => $r['quote_no'], 'status' => 'draft', 'client' => $clientArr['name'] ?? '', 'roof' => ['type' => $typeTxt, 'plan_area_sqft' => round($g['plan']), 'roof_area_sqft' => round($g['area']), 'billed_area_sqft_with_wastage' => round($g['billed'])],
                'assumptions' => $assume, 'warnings' => $warnings, 'app_url' => app_base_url() . '/index.html#/quotes/' . $r['id'], 'next_step' => 'A person should review this draft in the app (set the client if needed) and share it with the client from there.'];
            if (count($calc['packages']) === 1) { $out['material'] = $calc['packages'][0]['label']; $out['totals'] = ['subtotal' => $r['subtotal'], 'discount' => $r['discount'], 'gst' => $r['tax'], 'grand_total' => $r['total']]; }
            else {
                $out['options'] = []; $row = q('SELECT data FROM quotes WHERE id = ?', [$r['id']])->fetch(); $d2 = json_decode((string)$row['data'], true);
                foreach ($d2['options'] as $oi => $o) { $tmp = $d2; $tmp['selected_option'] = $oi; $out['options'][] = ['option' => $o['name'], 'material' => $o['note'], 'grand_total_incl_gst' => compute_totals($tmp)[4]]; }
                $out['selected_option'] = $d2['options'][0]['name'] . ' (the client chooses on the quote page)'; $out['totals'] = ['grand_total_for_selected_option' => $r['total']];
            }
            return $out;
        }];
    $T['list_projects'] = ['scope' => 'read', 'title' => 'List projects', 'description' => 'Projects created from accepted quotes with contract value, amount received, outstanding and overdue milestones.',
        'inputSchema' => ['type' => 'object', 'properties' => ['status' => ['type' => 'string', 'enum' => ['active', 'on_hold', 'completed']]]], 'annotations' => $ro, 'run' => function (array $a) {
            $rows = q("SELECT p.id,p.quote_no,p.name,p.division,p.status,p.base_value,p.tax_rate,(SELECT c.name FROM clients c WHERE c.id = p.client_id) AS client_name,
                (SELECT COALESCE(SUM(v.amount),0) FROM project_variations v WHERE v.project_id = p.id AND v.status = 'approved') AS varsum,
                (SELECT COALESCE(SUM(r.amount),0) FROM project_receipts r WHERE r.project_id = p.id) AS rec FROM projects p" . (!empty($a['status']) ? ' WHERE p.status = ?' : '') . ' ORDER BY p.id DESC LIMIT 100', !empty($a['status']) ? [(string)$a['status']] : [])->fetchAll();
            return array_map(function ($r) { $c = project_total($r, (float)$r['varsum']); return ['project_id' => (int)$r['id'], 'name' => $r['name'], 'quote_no' => $r['quote_no'], 'client' => $r['client_name'], 'division' => $r['division'], 'status' => $r['status'], 'contract_value' => $c, 'received' => (float)$r['rec'], 'outstanding' => money($c - (float)$r['rec'])]; }, $rows);
        }];
    $T['get_project'] = ['scope' => 'read', 'title' => 'Get project', 'description' => 'One project with billing milestones (due dates, paid / overdue), payments received, variation orders and the latest site-log entries.',
        'inputSchema' => ['type' => 'object', 'properties' => ['project_id' => ['type' => 'integer']], 'required' => ['project_id']], 'annotations' => $ro, 'run' => function (array $a) {
            $d = project_detail((int)($a['project_id'] ?? 0));
            return ['project' => $d['project'], 'totals' => $d['totals'], 'milestones' => array_map(fn($m) => ['milestone_id' => $m['id'], 'stage' => $m['label'], 'amount' => $m['amount'], 'paid' => $m['paid'], 'state' => $m['state'], 'due_date' => $m['due_date'], 'overdue' => $m['overdue'], 'invoice_no' => $m['invoice_no']], $d['milestones']),
                'payments' => array_map(fn($r) => ['date' => $r['received_on'], 'amount' => $r['amount'], 'mode' => $r['mode'], 'reference' => $r['reference']], $d['receipts']), 'variations' => array_map(fn($v) => ['title' => $v['title'], 'amount_ex_gst' => $v['amount'], 'status' => $v['status']], $d['variations']),
                'site_log' => array_slice(array_map(fn($l) => ['date' => $l['log_date'], 'text' => $l['text'], 'progress_percent' => $l['progress']], $d['log']), 0, 15), 'app_url' => app_base_url() . '/index.html#/projects/' . (int)$a['project_id']];
        }];
    $T['get_reports_summary'] = ['scope' => 'read', 'title' => 'Sales reports', 'description' => 'Win rate by division, quotes by month, performance by salesperson and lead source, margin by division (if permitted), aging of sent quotes and receivables.',
        'inputSchema' => ['type' => 'object', 'properties' => new stdClass()], 'annotations' => $ro, 'run' => fn(array $a) => reports()];

    $T['create_client'] = ['scope' => 'write', 'title' => 'Create client', 'description' => 'Add a client to the client book (or return the existing one with the same name). Returns client_id for create_quote_draft.',
        'inputSchema' => $clientObj, 'annotations' => $wr, 'run' => function (array $a) {
            $name = a_str($a, 'name', 190); if ($name === '') fail('name is required');
            $ex = q('SELECT id FROM clients WHERE LOWER(name) = LOWER(?)', [$name])->fetch();
            if ($ex) return ['client_id' => (int)$ex['id'], 'created' => false, 'note' => 'A client with this name already exists'];
            $f = client_fields($a);
            q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', array_merge($f, [now()]));
            return ['client_id' => (int)db()->lastInsertId(), 'created' => true];
        }];
    $T['create_quote_draft'] = ['scope' => 'write', 'title' => 'Create quote draft', 'description' => 'Create a DRAFT quotation. Use rate_item_id lines from search_rate_card (or calculate_roof lines). GST, payment schedule and terms default from Settings. The quote stays a draft: a person reviews it in the app (app_url) and decides whether to send it to the client. Returns totals so you can sanity-check.',
        'inputSchema' => ['type' => 'object', 'properties' => array_merge(['division' => $div, 'client_id' => ['type' => 'integer', 'description' => 'Existing client (see list_clients / create_client)'], 'client' => $clientObj], $draftProps), 'required' => ['division', 'lines']],
        'annotations' => $wr, 'run' => function (array $a) {
            $division = (string)($a['division'] ?? ''); if (!isset(DIVISIONS[$division])) fail('division must be one of: ' . implode(', ', array_keys(DIVISIONS)));
            if (empty($a['client_id']) && empty($a['client']['name'] ?? '')) fail('Provide client_id or client.name');
            $in = ['division' => $division, 'client_id' => (int)($a['client_id'] ?? 0) ?: null, 'client' => is_array($a['client'] ?? null) ? $a['client'] : [], 'title' => a_str($a, 'title'), 'data' => build_quote_input($a, $division)];
            if ($in['client_id']) { $c = q('SELECT * FROM clients WHERE id = ?', [$in['client_id']])->fetch(); if (!$c) fail('client_id not found'); $in['client'] = ['name' => $c['name'], 'contact_person' => $c['contact_person'], 'phone' => $c['phone'], 'email' => $c['email'], 'address' => $c['address'], 'gstin' => $c['gstin']]; }
            $r = create_quote($GLOBALS['MCP_USER'], $in);
            $psum = array_sum(array_column($in['data']['payment_schedule'], 'percent'));
            return ['quote_id' => $r['id'], 'quote_no' => $r['quote_no'], 'status' => 'draft', 'totals' => ['subtotal' => $r['subtotal'], 'discount' => $r['discount'], 'gst' => $r['tax'], 'round_off' => $r['round_off'], 'grand_total' => $r['total']],
                'warnings' => abs($psum - 100) > 0.01 && $psum > 0 ? ['Payment schedule totals ' . $psum . '%, not 100%'] : [], 'app_url' => app_base_url() . '/index.html#/quotes/' . $r['id'], 'next_step' => 'A person should review this draft in the app and share it with the client from there.'];
        }];
    $T['update_quote_draft'] = ['scope' => 'write', 'title' => 'Update quote draft', 'description' => 'Edit a quote that is still a DRAFT (latest revision). Any field you pass replaces the existing value; "lines" replaces ALL sections/lines. Sent, accepted or older quotes cannot be changed here.',
        'inputSchema' => ['type' => 'object', 'properties' => array_merge(['quote_id' => ['type' => 'integer']], $draftProps), 'required' => ['quote_id']], 'annotations' => ['readOnlyHint' => false, 'destructiveHint' => true, 'idempotentHint' => true, 'openWorldHint' => false],
        'run' => function (array $a) {
            $row = find_quote($a);
            if ($row['status'] !== 'draft' || !(int)$row['is_latest']) fail('Only a draft (latest revision) can be edited here. This quote is ' . $row['status'] . '.');
            $d = json_decode((string)$row['data'], true) ?: [];
            if (isset($a['lines'])) $d['sections'] = lines_to_sections((array)$a['lines'], $row['division']);
            foreach (['notes' => 'notes', 'scope' => 'scope', 'site_address' => 'site_address'] as $k => $dk) if (isset($a[$k])) $d[$dk] = a_str($a, $k, 3000);
            if (isset($a['area_sqft']) && is_numeric($a['area_sqft'])) $d['area_sqft'] = (float)$a['area_sqft'];
            if (isset($a['gst_percent']) && is_numeric($a['gst_percent'])) $d['tax_rate'] = (float)$a['gst_percent'];
            if (isset($a['round_off'])) $d['round_off'] = (bool)$a['round_off'];
            if (isset($a['discount_flat']) && is_numeric($a['discount_flat'])) $d['discount'] = ['type' => 'flat', 'value' => (float)$a['discount_flat']]; elseif (isset($a['discount_percent']) && is_numeric($a['discount_percent'])) $d['discount'] = ['type' => 'percent', 'value' => (float)$a['discount_percent']];
            if (isset($a['terms']) && is_array($a['terms'])) $d['terms'] = array_map('strval', $a['terms']);
            if (isset($a['payment_schedule']) && is_array($a['payment_schedule'])) $d['payment_schedule'] = array_map(fn($p) => ['label' => (string)($p['stage'] ?? $p['label'] ?? ''), 'percent' => (float)($p['percent'] ?? 0)], $a['payment_schedule']);
            $in = ['division' => $row['division'], 'client_id' => $row['client_id'], 'client' => json_decode((string)$row['client_json'], true) ?: [], 'title' => isset($a['title']) ? a_str($a, 'title') : $row['title'], 'quote_date' => $row['quote_date'], 'valid_until' => $row['valid_until'], 'data' => $d];
            [$division, $title, $data, $client, $date, $valid, $cid] = clean_quote_input($in, $row['division']);
            [$sub, $disc, $tax, $round, $total] = compute_totals($data);
            $u = q('UPDATE quotes SET title=?,data=?,subtotal=?,discount=?,tax=?,round_off=?,total=?,updated_at=? WHERE id=? AND status = ?', [$title, json_encode($data, JSON_UNESCAPED_UNICODE), $sub, $disc, $tax, $round, $total, now(), $row['id'], 'draft']);
            if ($u->rowCount() !== 1) fail('The quote changed while editing (it may have been sent). Reload and retry.');
            return ['quote_id' => (int)$row['id'], 'quote_no' => $row['quote_no'], 'status' => 'draft', 'totals' => ['subtotal' => $sub, 'discount' => $disc, 'gst' => $tax, 'round_off' => $round, 'grand_total' => $total], 'app_url' => app_base_url() . '/index.html#/quotes/' . (int)$row['id']];
        }];
    $T['add_project_log'] = ['scope' => 'write', 'title' => 'Add site-log entry', 'description' => 'Append a site update (what happened, optional overall progress %) to a project\'s site log.',
        'inputSchema' => ['type' => 'object', 'properties' => ['project_id' => ['type' => 'integer'], 'text' => ['type' => 'string'], 'progress_percent' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 100], 'date' => ['type' => 'string', 'description' => 'YYYY-MM-DD, default today']], 'required' => ['project_id', 'text']],
        'annotations' => $wr, 'run' => function (array $a) {
            $pid = (int)($a['project_id'] ?? 0); if (!q('SELECT 1 FROM projects WHERE id = ?', [$pid])->fetch()) fail('Project not found');
            $t = a_str($a, 'text', 2000); if ($t === '') fail('text is required');
            $pg = isset($a['progress_percent']) && is_numeric($a['progress_percent']) ? max(0, min(100, (int)$a['progress_percent'])) : null;
            q('INSERT INTO project_log (project_id,log_date,text,progress,author,created_at) VALUES (?,?,?,?,?,?)', [$pid, pdate($a['date'] ?? null) ?: date('Y-m-d'), $t, $pg, $GLOBALS['MCP_USER']['name'], now()]);
            return ['ok' => true, 'project_id' => $pid];
        }];
    return $tools = $T;
}

/* ---------------- prompts (ready-made workflows) ---------------- */
function mcp_prompt_list(): array
{
    return [
        ['name' => 'draft_quote_from_brief', 'title' => 'Draft a quote from a client brief', 'description' => 'Turn a free-text client enquiry into a priced draft quotation using the real rate card.', 'arguments' => [['name' => 'brief', 'description' => 'The client\'s requirement in plain words', 'required' => true]]],
        ['name' => 'compare_roofing_options', 'title' => 'Compare roofing materials', 'description' => 'Price a roof in GI, UPVC, PUF and aluminium and recommend one.', 'arguments' => [['name' => 'details', 'description' => 'e.g. "100 x 40 ft godown, gable roof"', 'required' => true]]],
        ['name' => 'weekly_sales_review', 'title' => 'Weekly sales & collections review', 'description' => 'Summarise pipeline, follow-ups, win rate and overdue payments with suggested actions.', 'arguments' => []],
    ];
}
function mcp_prompt_get(string $name, array $args): array
{
    $msg = fn(string $t) => ['description' => $name, 'messages' => [['role' => 'user', 'content' => ['type' => 'text', 'text' => $t]]]];
    switch ($name) {
        case 'draft_quote_from_brief':
            return $msg("Draft a quotation for this client brief:\n\n" . a_str($args, 'brief', 4000) . "\n\nSteps: 1) Pick the division. 2) Use list_clients / create_client for the client. 3) For every line use search_rate_card to find real items (never invent rates); for roofing use calculate_roof. 4) Call create_quote_draft. 5) Report the quote number, grand total and any assumptions or missing information, and give the app_url so a person can review it. Do not claim the quote has been sent.");
        case 'compare_roofing_options':
            return $msg("Price this roof in GI, UPVC, PUF 50 mm and aluminium using calculate_roof:\n\n" . a_str($args, 'details', 2000) . "\n\nPresent a short comparison table (price incl. GST, per sq ft, key trade-offs: durability, insulation, noise, maintenance) and recommend one. Offer to create a draft with the chosen option, or Good/Better/Best alternatives to discuss with the client.");
        case 'weekly_sales_review':
            return $msg("Run a weekly review: call get_business_overview and get_reports_summary, then list overdue payments via list_projects / get_project. Summarise (1) pipeline and win rate, (2) quotes needing follow-up with the client names, (3) money to collect, (4) three concrete actions for this week. Be specific and brief.");
    }
    throw new ApiFailure('Unknown prompt: ' . $name);
}
