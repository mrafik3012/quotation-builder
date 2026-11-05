<?php
declare(strict_types=1);
require_once __DIR__ . '/core.php';
// One-step quotes for Interior, Construction and PMC: a few inputs in, a fully priced draft out.
// Every price comes from the rate card (active items matched by name, falling back to a built-in default), so editing
// the rate card changes what these quotes cost. Roofing has its own calculator (roofing_quote_create in core.php).

const QUICK_DIVISIONS = ['interior', 'construction', 'pmc'];

/** A priced line from the rate card (by exact name; falls back to $defRate when the item was renamed or removed). */
function qline(string $division, string $name, string $unit, float $qty, float $defRate, ?float $rateOverride = null, ?string $desc = null): array
{
    $it = q('SELECT name, unit, rate, cost FROM rate_items WHERE division = ? AND name = ? AND active = 1 LIMIT 1', [$division, $name])->fetch();
    $rate = $rateOverride ?? ($it ? (float)$it['rate'] : $defRate);
    $cost = $rateOverride !== null ? round($rateOverride * 0.8, 2) : ($it ? (float)$it['cost'] : round($defRate * 0.8, 2));
    return ['desc' => $desc ?? $name, 'unit' => $it ? (string)$it['unit'] : $unit, 'qty' => round($qty, 2), 'rate' => round($rate, 2), 'cost' => $cost, 'note' => ''];
}

function quick_num(array $a, string $k, float $min, float $max, ?float $default = null): float
{
    $v = $a[$k] ?? null;
    if ($v === null || $v === '') { if ($default !== null) return $default; fail($k . ' is required'); }
    if (!is_numeric($v) || (float)$v < $min || (float)$v > $max) fail($k . ' must be a number between ' . $min . ' and ' . $max);
    return (float)$v;
}

/** @return array{0:array,1:string,2:string} [sections for one tier, title fragment, scope sentence] */
function quick_interior(array $a, string $tier): array
{
    $bhk = (int)quick_num($a, 'bhk', 1, 6);
    $carpet = quick_num($a, 'carpet_sqft', 200, 20000, [1 => 550, 2 => 900, 3 => 1300, 4 => 1800, 5 => 2400, 6 => 3000][$bhk]);
    $prem = $tier === 'premium'; $D = 'interior';
    $kitchen = round(60 + 15 * ($bhk - 1)); $wardrobe = $bhk * 45; $points = max(10, (int)round($carpet / 22.5)); $lights = max(4, (int)round($carpet / 18));
    $kit = [
        qline($D, $prem ? 'Modular kitchen - acrylic / PU finish' : 'Modular kitchen - BWP ply carcass, laminate finish', 'sq ft', $kitchen, $prem ? 2400 : 1650),
        qline($D, $prem ? 'Quartz / engineered stone countertop' : 'Granite kitchen countertop with polish', 'rft', 10 + 2 * $bhk, $prem ? 2800 : 1400),
        qline($D, 'Kitchen sink - SS double bowl, with tap', 'nos', 1, 9000),
        qline($D, 'Kitchen chimney - supply & installation (allowance)', 'nos', 1, 14000),
    ];
    $bed = [
        qline($D, $prem ? 'Wardrobe - acrylic / PU shutters' : 'Wardrobe - sliding door, laminate finish', 'sq ft', $wardrobe, $prem ? 1900 : 1450),
        qline($D, 'TV unit with back panel', 'sq ft', 30, 1350),
        qline($D, 'Shoe rack', 'sq ft', 15, 1100),
    ];
    if ($prem) { $bed[] = qline($D, 'Crockery unit / display unit', 'sq ft', 25, 1550); $bed[] = qline($D, 'Pooja unit', 'nos', 1, 22000); }
    $fin = [
        qline($D, $prem ? 'Gypsum false ceiling with cove lighting' : 'Gypsum false ceiling - plain', 'sq ft', round($carpet * 0.7), $prem ? 120 : 85),
        qline($D, $prem ? 'Interior premium emulsion (Royale type) - 2 coats' : 'Interior emulsion paint - putty + 2 coats', 'sq ft', round($carpet * 3.2), $prem ? 36 : 28),
        qline($D, 'Concealed conduit & wiring - per point', 'nos', $points, 950),
        qline($D, 'Spot / downlight (recessed)', 'nos', $lights, 550),
    ];
    $secs = [['title' => 'Kitchen', 'items' => $kit, 'images' => []], ['title' => 'Bedrooms & Living', 'items' => $bed, 'images' => []], ['title' => 'Ceiling, Paint & Electrical', 'items' => $fin, 'images' => []]];
    return [$secs, $bhk . ' BHK interior (' . $tier . ')', "Complete interior works for a {$bhk} BHK home of about " . (int)$carpet . ' sq ft: modular kitchen, wardrobes and storage, false ceiling, painting and electrical points, supplied and installed to the ' . $tier . ' specification.'];
}

function quick_construction(array $a, string $finish): array
{
    $area = quick_num($a, 'built_up_sqft', 100, 500000); $floors = max(1, (int)quick_num($a, 'floors', 1, 60, 1)); $D = 'construction';
    $map = ['grey' => ['Turnkey construction - grey structure', 1750, 'grey structure'], 'standard' => ['Turnkey construction - with finishing', 2400, 'standard finish'], 'premium' => ['Turnkey - villa premium finish', 3200, 'premium finish']];
    [$name, $def, $label] = $map[$finish];
    $items = [qline($D, $name, 'sq ft', $area, $def)];
    if (!isset($a['include_waterproofing']) || $a['include_waterproofing']) $items[] = qline($D, 'Terrace waterproofing - APP membrane', 'sq ft', round($area / $floors), 110);
    if (!isset($a['include_design']) || $a['include_design']) $items[] = qline($D, 'Architectural & structural design', 'sq ft', $area, 120);
    if (!isset($a['include_approvals']) || $a['include_approvals']) $items[] = qline($D, 'Building plan approval & statutory fees (allowance)', 'lot', 1, 65000);
    $items[] = qline($D, 'Material testing & quality tests', 'lot', 1, 22000);
    $items[] = qline($D, 'Insurance - CAR policy', 'lot', 1, 35000);
    return [[['title' => 'Construction Works', 'items' => $items, 'images' => []]], 'Construction ' . (int)$area . ' sq ft (' . $label . ')',
        'Turnkey construction of a ' . (int)$area . ' sq ft built-up building (' . $floors . ' floor' . ($floors > 1 ? 's' : '') . ') to ' . $label . ', including the items listed below.'];
}

function quick_pmc(array $a, string $variant): array
{
    $months = (int)quick_num($a, 'duration_months', 1, 60); $D = 'pmc';
    $cost = isset($a['project_cost']) && $a['project_cost'] !== '' ? quick_num($a, 'project_cost', 100000, 1.0E11) : 0.0;
    $area = isset($a['built_up_sqft']) && $a['built_up_sqft'] !== '' ? quick_num($a, 'built_up_sqft', 100, 5000000) : 0.0;
    if ($cost <= 0 && $area <= 0) fail('Give project_cost (Rs) or built_up_sqft');
    $items = [];
    if ($variant === 'part') $items[] = qline($D, 'Fee for part-scope (design review / QS only)', 'lot', 1, 90000);
    elseif ($cost > 0) {
        $pct = $cost <= 50000000 ? 3.0 : ($cost <= 250000000 ? 2.5 : 2.0);
        $fee = round($cost * $pct / 100, 2);
        $items[] = ['desc' => 'PMC fee - ' . rtrim(rtrim(number_format($pct, 2), '0'), '.') . '% of project cost (Rs ' . number_format($cost, 0) . ')', 'unit' => 'lot', 'qty' => 1, 'rate' => $fee, 'cost' => round($fee * 0.8, 2), 'note' => ''];
    } else $items[] = qline($D, 'PMC fee per sq ft of built-up area', 'sq ft', $area, 60);
    if ($variant === 'full') {
        if (!isset($a['site_staff']) || $a['site_staff']) {
            $items[] = qline($D, 'Full-time site engineer', 'month', $months, 45000);
            $items[] = qline($D, 'Quantity surveying & RA bill verification', 'month', $months, 25000);
        }
        $items[] = qline($D, 'Quality audit visit - structural works', 'visit', max(1, (int)round($months / 2)), 9000);
        $items[] = qline($D, 'Safety audit (site)', 'visit', max(1, (int)round($months / 3)), 10000);
        $items[] = qline($D, 'Quality assurance plan & checklists', 'lot', 1, 35000);
        $items[] = qline($D, 'Pre-handover inspection & snagging', 'lot', 1, 45000);
    }
    return [[['title' => 'PMC Services', 'items' => $items, 'images' => []]], 'PMC ' . $months . ' months (' . ($variant === 'part' ? 'part scope' : 'full scope') . ')',
        'Project management consultancy for ' . $months . ' months' . ($cost > 0 ? ' on a project of about Rs ' . number_format($cost, 0) : ' on about ' . (int)$area . ' sq ft') . ($variant === 'part' ? ': design review and quantity surveying only.' : ': planning, site supervision, quality and safety audits, cost control and handover.')];
}

/** Create a priced DRAFT for interior / construction / pmc. Several tiers (standard+premium, grey+standard+premium, full+part) become selectable options. */
function quick_quote_create(string $division, array $a, array $user): array
{
    if (!in_array($division, QUICK_DIVISIONS, true)) fail('Quick quotes are available for interior, construction and pmc');
    $valid = ['interior' => ['standard', 'premium'], 'construction' => ['grey', 'standard', 'premium'], 'pmc' => ['full', 'part']][$division];
    $want = isset($a['variants']) && is_array($a['variants']) && $a['variants'] ? array_values(array_unique(array_map('strval', $a['variants']))) : [(string)($a['variant'] ?? ($division === 'pmc' ? 'full' : 'standard'))];
    foreach ($want as $v) if (!in_array($v, $valid, true)) fail('variant must be one of: ' . implode(', ', $valid));
    $built = array_map(fn($v) => [$v, ...match ($division) { 'interior' => quick_interior($a, $v), 'construction' => quick_construction($a, $v), 'pmc' => quick_pmc($a, $v) }], $want);

    if (!empty($a['client_id'])) { $cl = q('SELECT * FROM clients WHERE id = ?', [(int)$a['client_id']])->fetch(); if (!$cl) fail('client_id not found'); $client = ['name' => $cl['name'], 'contact_person' => $cl['contact_person'], 'phone' => $cl['phone'], 'email' => $cl['email'], 'address' => $cl['address'], 'gstin' => $cl['gstin']]; }
    elseif (!empty($a['client']['name'] ?? '')) { $cl = null; $client = $a['client']; }
    else {
        $cl = q('SELECT * FROM clients WHERE name = ?', ['Client to be confirmed'])->fetch();
        if (!$cl) { q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', ['Client to be confirmed', '', '', '', '', '', now()]); $cl = q('SELECT * FROM clients WHERE name = ?', ['Client to be confirmed'])->fetch(); }
        $client = ['name' => $cl['name'], 'contact_person' => '', 'phone' => '', 'email' => '', 'address' => '', 'gstin' => ''];
    }

    $data = build_quote_input(['gst_percent' => $a['gst_percent'] ?? null, 'discount_percent' => $a['discount_percent'] ?? null, 'notes' => $a['notes'] ?? '', 'site_address' => $a['site_address'] ?? ''], $division);
    $data['source'] = 'Quick quote';
    $data['scope'] = $built[0][3];
    if (count($built) === 1) $data['sections'] = $built[0][1];
    else {
        $data['sections'] = [];
        $data['options'] = array_map(fn($b) => ['name' => ucfirst($b[0]), 'note' => $b[2], 'sections' => $b[1]], $built);
        $data['scope'] = 'Choose the option that suits you: ' . implode('; ', array_map(fn($b) => ucfirst($b[0]) . ' - ' . $b[2], $built)) . '.';
    }
    $title = a_str($a, 'title') ?: (count($built) === 1 ? $built[0][2] : ucfirst($division) . ' - ' . implode(' / ', array_map(fn($b) => ucfirst($b[0]), $built)));
    $r = create_quote($user, ['division' => $division, 'client_id' => $cl ? (int)$cl['id'] : null, 'client' => $client, 'title' => mb_substr($title, 0, 250), 'data' => $data]);
    $out = ['quote_id' => $r['id'], 'quote_no' => $r['quote_no'], 'status' => 'draft', 'division' => $division, 'client' => $client['name'] ?? '', 'title' => $title,
        'app_url' => app_base_url() . '/index.html#/quotes/' . $r['id'], 'warnings' => empty($a['client_id']) && empty($a['client']['name'] ?? '') ? ['No client was given, so the draft is under "Client to be confirmed".'] : []];
    if (count($built) === 1) $out['totals'] = ['subtotal' => $r['subtotal'], 'discount' => $r['discount'], 'gst' => $r['tax'], 'grand_total' => $r['total']];
    else {
        $out['options'] = [];
        foreach ($data['options'] as $i => $o) { $tmp = $data; $tmp['selected_option'] = $i; $out['options'][] = ['option' => $o['name'], 'grand_total_incl_gst' => compute_totals($tmp)[4]]; }
        $out['totals'] = ['grand_total_for_selected_option' => $r['total']];
    }
    return $out;
}
