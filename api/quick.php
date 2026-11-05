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


const ROOM_TYPES = ['living' => 'Living', 'bedroom' => 'Bedroom', 'kitchen' => 'Kitchen', 'bathroom' => 'Bathroom', 'dining' => 'Dining', 'study' => 'Study', 'pooja' => 'Pooja', 'balcony' => 'Balcony', 'utility' => 'Utility'];

/** Room-by-room interior take-off from real dimensions. Returns one section per room plus a whole-home section. */
function quick_interior_rooms(array $a, string $tier): array
{
    $rooms = $a['rooms'] ?? null;
    if (!is_array($rooms) || !$rooms || count($rooms) > 30) fail('rooms must list 1 to 30 rooms');
    $prem = $tier === 'premium'; $D = 'interior'; $flooring = !empty($a['include_flooring']);
    $secs = []; $total = 0.0; $bedN = 0; $baths = 0;
    foreach ($rooms as $i => $r) {
        if (!is_array($r)) fail('Room ' . ($i + 1) . ' is invalid');
        $type = (string)($r['type'] ?? ''); if (!isset(ROOM_TYPES[$type])) fail('Room ' . ($i + 1) . ': type must be one of ' . implode(', ', array_keys(ROOM_TYPES)));
        $L = quick_num($r, 'length_ft', 3, 100); $W = quick_num($r, 'width_ft', 3, 100); $H = quick_num($r, 'height_ft', 7, 20, 10);
        $area = $L * $W; $total += $area; $perim = 2 * ($L + $W); $short = min($L, $W); $long = max($L, $W);
        $openings = $type === 'bathroom' ? 27 : ($type === 'balcony' ? 21 : 36);       // door + window, sq ft
        $wall = max(0, $perim * $H - $openings);
        $name = trim((string)($r['name'] ?? '')) ?: (ROOM_TYPES[$type] . ($type === 'bedroom' ? ' ' . (++$bedN) : ''));
        $it = [];
        if ($type === 'bedroom') {
            $it[] = qline($D, $prem ? 'Wardrobe - acrylic / PU shutters' : 'Wardrobe - sliding door, laminate finish', 'sq ft', round($short * 0.6 * 8), $prem ? 1900 : 1450);
            $it[] = qline($D, 'Bed back-panel / headboard (upholstered)', 'nos', 1, 16000);
            if ($prem && $bedN === 1) $it[] = qline($D, 'Dressing unit with mirror', 'nos', 1, 18000);
        } elseif ($type === 'living') {
            $tv = round(min(10, $long * 0.5) * 6);
            $it[] = qline($D, 'TV unit with back panel', 'sq ft', $tv, 1350);
            $it[] = qline($D, 'Shoe rack', 'sq ft', 15, 1100);
            if ($prem) $it[] = qline($D, 'Wall panelling - fluted / charcoal panel', 'sq ft', round(min(10, $long * 0.5) * 8), 260);
        } elseif ($type === 'dining') {
            $it[] = qline($D, 'Crockery unit / display unit', 'sq ft', 25, 1550);
        } elseif ($type === 'study') {
            $it[] = qline($D, 'Study table with storage', 'nos', 1, 16500);
            $it[] = qline($D, 'Book shelf / open shelving', 'sq ft', 30, 1100);
        } elseif ($type === 'pooja') {
            $it[] = qline($D, 'Pooja unit', 'nos', 1, 22000);
        } elseif ($type === 'utility') {
            $it[] = qline($D, 'Utility / laundry cabinet', 'sq ft', 20, 1250);
        } elseif ($type === 'kitchen') {
            $run = max(6.0, $L + $W - 2);                                          // L-shaped run along two walls
            $it[] = qline($D, $prem ? 'Modular kitchen - acrylic / PU finish' : 'Modular kitchen - BWP ply carcass, laminate finish', 'sq ft', round($run * 6), $prem ? 2400 : 1650);
            $it[] = qline($D, $prem ? 'Quartz / engineered stone countertop' : 'Granite kitchen countertop with polish', 'rft', round($run), $prem ? 2800 : 1400);
            $it[] = qline($D, 'Kitchen backsplash tile / glass', 'sq ft', round($run * 2), 160);
            $it[] = qline($D, 'Kitchen sink - SS double bowl, with tap', 'nos', 1, 9000);
            $it[] = qline($D, 'Kitchen chimney - supply & installation (allowance)', 'nos', 1, 14000);
            $wall = max(0, $wall - $run * 2);
        } elseif ($type === 'bathroom') {
            $baths++;
            $it[] = qline($D, 'Waterproofing - bathroom floor & wall', 'sq ft', round($area + $perim * 3), 75);
            $it[] = qline($D, $prem ? 'Vanity unit with mirror' : 'Wash basin - counter-top with cabinet', 'nos', 1, $prem ? 14500 : 9000);
            $it[] = qline($D, 'Wall-mounted WC with concealed cistern', 'nos', 1, 14500);
            $it[] = qline($D, 'Shower enclosure - glass partition', 'sq ft', 21, 650);
            $it[] = qline($D, 'CP fittings - premium (per bathroom)', 'lot', 1, 28000);
            $it[] = qline($D, 'Water heater / geyser - supply & fixing', 'nos', 1, 3500);
            $it[] = qline($D, 'Bath accessories set (towel rail, hooks, etc.)', 'lot', 1, 4500);
        }
        $falseCeil = in_array($type, ['living', 'bedroom', 'dining', 'study', 'pooja'], true);
        if ($falseCeil) $it[] = qline($D, $prem ? 'Gypsum false ceiling with cove lighting' : 'Gypsum false ceiling - plain', 'sq ft', round($area), $prem ? 120 : 85);
        if ($type !== 'bathroom') {
            $it[] = qline($D, $prem ? 'Interior premium emulsion (Royale type) - 2 coats' : 'Interior emulsion paint - putty + 2 coats', 'sq ft', round($wall), $prem ? 36 : 28);
            $it[] = qline($D, 'Ceiling paint - putty + 2 coats', 'sq ft', round($area), 30);
        }
        if ($flooring && $type !== 'bathroom') $it[] = qline($D, $prem ? 'Italian marble flooring - supply & laying' : 'Vitrified tile flooring - supply & laying', 'sq ft', round($area), $prem ? 380 : 95);
        $pts = $type === 'bathroom' ? 3 : ($type === 'kitchen' ? 8 + (int)ceil($area / 40) : max(4, (int)ceil($area / 25) + 2));
        $it[] = qline($D, 'Concealed conduit & wiring - per point', 'nos', $pts, 950);
        $lights = $type === 'bathroom' ? 2 : ($type === 'balcony' ? 1 : max(2, (int)ceil($area / 20)));
        $it[] = qline($D, 'Spot / downlight (recessed)', 'nos', $lights, 550);
        if (in_array($type, ['living', 'bedroom', 'dining', 'study'], true)) $it[] = qline($D, 'Ceiling fan - supply & fixing', 'nos', $area > 200 ? 2 : 1, 3800);
        $secs[] = ['title' => $name . ' (' . rtrim(rtrim(number_format($L, 1), '0'), '.') . ' x ' . rtrim(rtrim(number_format($W, 1), '0'), '.') . ' ft)', 'items' => $it, 'images' => []];
    }
    $home = [qline($D, 'MCB distribution board - supply & fixing', 'nos', 1, 6500)];
    $ac = (int)quick_num($a, 'ac_points', 0, 20, 0); if ($ac > 0) $home[] = qline($D, 'AC point with copper piping', 'nos', $ac, 9500);
    $secs[] = ['title' => 'Whole home', 'items' => $home, 'images' => []];
    $scope = 'Interior works for ' . count($rooms) . ' room' . (count($rooms) > 1 ? 's' : '') . ' (about ' . (int)round($total) . ' sq ft), measured room by room: furniture and storage, false ceilings, painting, electrical points' . ($baths ? ', bathroom fittings' : '') . ($flooring ? ' and flooring' : '') . ', to the ' . $tier . ' specification.';
    return [$secs, count($rooms) . ' rooms interior (' . $tier . ')', $scope];
}

/** Detailed construction bill of quantities from standard thumb rules for RCC-framed buildings. */
function quick_construction_boq(array $a, string $finish): array
{
    $A = quick_num($a, 'built_up_sqft', 100, 500000); $n = max(1, (int)quick_num($a, 'floors', 1, 60, 1)); $D = 'construction';
    $grey = $finish === 'grey'; $prem = $finish === 'premium';
    $F = $A / $n; $cum = fn(float $cft) => $cft / 35.3147;
    $baths = max(1, (int)round($A / 450)); $doors = max(3, (int)round($A / 130)); $extWall = 4 * sqrt($F) * 10 * $n;
    $site = [qline($D, 'Site clearing & levelling', 'sq ft', round($F * 1.5), 6), qline($D, 'Survey & layout marking (setting out)', 'lot', 1, 15000), qline($D, 'Soil testing & geotechnical investigation', 'nos', 1, 22000),
        qline($D, 'Temporary site office, store & hoarding', 'lot', 1, 45000), qline($D, 'Temporary water & electricity connection', 'lot', 1, 25000),
        qline($D, 'Excavation in all soils', 'cum', round($cum($F * 1.3 * 4), 1), 380), qline($D, 'Backfilling & compaction', 'cum', round($cum($F * 1.3 * 4) * 0.4, 1), 220),
        qline($D, 'Sand filling under floors', 'cum', round($cum($F), 1), 950), qline($D, 'Anti-termite treatment', 'sq ft', round($F), 12)];
    $str = [qline($D, 'Isolated footing / pile cap concrete M25', 'cum', round($A * 0.0054, 1), 8500), qline($D, 'Plinth beam - concrete & shuttering', 'cum', round($A * 0.0027, 1), 9200),
        qline($D, 'Column - concrete M25', 'cum', round($A * 0.0063, 1), 9800), qline($D, 'Beam & slab - RCC M25', 'cum', round($A * 0.0306, 1), 9000),
        qline($D, 'TMT reinforcement Fe500D - supply, cut, bend & tie', 'kg', round($A * 4.0), 78), qline($D, 'Shuttering - plywood centering for slabs', 'sq ft', round($A), 105),
        qline($D, 'Shuttering - columns & beams', 'sq ft', round($A * 0.9), 120), qline($D, 'Binding wire & cover blocks', 'lot', 1, 9000), qline($D, 'Curing & compound', 'lot', 1, 12000),
        qline($D, 'Staircase - RCC with finishing', 'sq ft', 40 * $n, 1450), qline($D, 'Overhead water tank - RCC', 'nos', 1, 75000), qline($D, 'Underground sump / septic tank', 'nos', 1, 85000),
        qline($D, 'Scaffolding for building works', 'sq ft', round($extWall), 45)];
    $mas = [qline($D, 'AAC block masonry 200 mm', 'cum', round($A * 0.026, 1), 6200)];
    if (!$grey) { $mas[] = qline($D, 'Gypsum plaster - internal', 'sq ft', round($A * 2.0), 42); $mas[] = qline($D, 'Sponge-finish external plaster', 'sq ft', round($extWall), 52); $mas[] = qline($D, 'Plaster - ceiling, 12 mm', 'sq ft', round($A), 40); }
    $secs = [['title' => 'Site preparation & earthwork', 'items' => $site, 'images' => []], ['title' => 'Foundation & RCC structure', 'items' => $str, 'images' => []], ['title' => 'Masonry & plaster', 'items' => $mas, 'images' => []]];
    $wp = [qline($D, 'Terrace waterproofing - APP membrane', 'sq ft', round($F), 110)];
    if (!$grey) {
        $wp[] = qline($D, 'Bathroom / wet area waterproofing', 'sq ft', 60 * $baths, 65);
        $fl = [qline($D, $prem ? 'Marble flooring - Rajasthan / Makrana' : 'Vitrified tile - 2x2 ft with skirting', 'sq ft', round($A * 0.75), $prem ? 250 : 120), qline($D, 'Anti-skid tile - bathroom / terrace', 'sq ft', 40 * $baths, 90), qline($D, 'Wall tile - bathroom 12x18', 'sq ft', 120 * $baths, 95)];
        $dw = [qline($D, 'Main teak door with frame', 'nos', 1, 38000), qline($D, 'Flush door 35 mm - with hardware', 'nos', max(1, $doors - 1 - $baths), 11500), qline($D, 'Bathroom door - PVC / FRP', 'nos', $baths, 6500),
            qline($D, $prem ? 'UPVC window with glass' : 'Aluminium sliding window', 'sq ft', round($A * 0.10), $prem ? 480 : 420), qline($D, 'MS grill - safety', 'sq ft', round($A * 0.06), 165)];
        $mep = [qline($D, 'Concealed electrical wiring - per point', 'nos', max(10, (int)round($A / 25)), 900), qline($D, 'Electrical panel & DB (3-phase)', 'nos', 1, 32000), qline($D, 'Earthing - plate / pipe earthing', 'nos', 1, 9000),
            qline($D, 'Plumbing - CPVC / UPVC internal piping (per bathroom)', 'nos', $baths, 24000), qline($D, 'Sanitary fixtures - per bathroom (basic)', 'nos', $baths, 32000),
            qline($D, 'Drainage - UPVC / SWR piping', 'rft', round($A * 0.12), 210), qline($D, 'Water supply - overhead tank to points', 'lot', 1, 45000)];
        $pt = [qline($D, 'Internal wall putty - 2 coats', 'sq ft', round($A * 2.6), 16), qline($D, 'Exterior paint - premium emulsion with primer', 'sq ft', round($extWall), 38)];
        if ($prem) $pt[] = qline($D, 'Texture / exterior cladding finish', 'sq ft', round($extWall * 0.15), 110);
        array_push($secs, ['title' => 'Waterproofing', 'items' => $wp, 'images' => []], ['title' => 'Flooring & tiling', 'items' => $fl, 'images' => []], ['title' => 'Doors & windows', 'items' => $dw, 'images' => []], ['title' => 'Electrical & plumbing', 'items' => $mep, 'images' => []], ['title' => 'Painting & finishes', 'items' => $pt, 'images' => []]);
    } else array_splice($secs, 3, 0, [['title' => 'Waterproofing', 'items' => $wp, 'images' => []]]);
    $stat = [];
    if (!isset($a['include_design']) || $a['include_design']) $stat[] = qline($D, 'Architectural & structural design', 'sq ft', $A, 120);
    if (!isset($a['include_approvals']) || $a['include_approvals']) $stat[] = qline($D, 'Building plan approval & statutory fees (allowance)', 'lot', 1, 65000);
    $stat[] = qline($D, 'Material testing & quality tests', 'lot', 1, 22000); $stat[] = qline($D, 'Insurance - CAR policy', 'lot', 1, 35000);
    $sum = 0.0; foreach ($secs as $sc) foreach ($sc['items'] as $x) $sum += $x['qty'] * $x['rate'];
    if (!isset($a['include_overheads']) || $a['include_overheads']) {
        $oh = round($sum * 0.12, 2); $stat[] = ['desc' => 'Contractor overhead & profit (12%)', 'unit' => 'lot', 'qty' => 1, 'rate' => $oh, 'cost' => 0, 'note' => ''];
        $cg = round($sum * 0.05, 2); $stat[] = ['desc' => 'Contingency (5%)', 'unit' => 'lot', 'qty' => 1, 'rate' => $cg, 'cost' => 0, 'note' => ''];
    }
    $secs[] = ['title' => 'Statutory, testing & overheads', 'items' => $stat, 'images' => []];
    $label = ['grey' => 'grey structure', 'standard' => 'standard finish', 'premium' => 'premium finish'][$finish];
    return [$secs, 'Construction ' . (int)$A . ' sq ft - detailed BOQ (' . $label . ')',
        'Construction of a ' . (int)$A . ' sq ft RCC-framed building (' . $n . ' floor' . ($n > 1 ? 's' : '') . ') to ' . $label . ', itemised below. Quantities are estimated with standard thumb rules and will be confirmed against the approved drawings.'];
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
    $built = array_map(fn($v) => [$v, ...match ($division) { 'interior' => (!empty($a['rooms']) ? quick_interior_rooms($a, $v) : quick_interior($a, $v)), 'construction' => (!empty($a['detailed']) ? quick_construction_boq($a, $v) : quick_construction($a, $v)), 'pmc' => quick_pmc($a, $v) }], $want);

    if (!empty($a['client_id'])) { $cl = q('SELECT * FROM clients WHERE id = ?', [(int)$a['client_id']])->fetch(); if (!$cl) fail('client_id not found'); $client = ['name' => $cl['name'], 'contact_person' => $cl['contact_person'], 'phone' => $cl['phone'], 'email' => $cl['email'], 'address' => $cl['address'], 'gstin' => $cl['gstin']]; }
    elseif (!empty($a['client']['name'] ?? '')) { $cl = null; $client = $a['client']; }
    else {
        $cl = q('SELECT * FROM clients WHERE name = ?', ['Client to be confirmed'])->fetch();
        if (!$cl) { q('INSERT INTO clients (name,contact_person,phone,email,address,gstin,created_at) VALUES (?,?,?,?,?,?,?)', ['Client to be confirmed', '', '', '', '', '', now()]); $cl = q('SELECT * FROM clients WHERE name = ?', ['Client to be confirmed'])->fetch(); }
        $client = ['name' => $cl['name'], 'contact_person' => '', 'phone' => '', 'email' => '', 'address' => '', 'gstin' => ''];
    }

    $data = build_quote_input(['gst_percent' => $a['gst_percent'] ?? null, 'discount_percent' => $a['discount_percent'] ?? null, 'notes' => $a['notes'] ?? '', 'site_address' => $a['site_address'] ?? ''], $division);
    $data['source'] = 'Quick quote';
    if (($division === 'construction' && !empty($a['detailed'])) || ($division === 'interior' && !empty($a['rooms']))) $data['notes'] = trim(($data['notes'] ?? '') . "\nQuantities are estimates from room dimensions / standard thumb rules and are confirmed on site measurement or approved drawings.");
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
