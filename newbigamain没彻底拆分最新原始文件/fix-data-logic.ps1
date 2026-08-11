# fix-data-logic.ps1 — Move getNumericVolume and _moduleKey to data layer

# 1. Add functions to data/supabase-client.js
$f1 = "C:\Users\jialeok\Desktop\biga-main\src\data\supabase-client.js"
$c1 = [System.IO.File]::ReadAllText($f1, [System.Text.Encoding]::UTF8)

$funcs = @"

// ============================================================
// 共享工具函数 — 供 data/ 和 logic/ 层共用
// ============================================================
export function getNumericVolume(val) {
    if (val === '' || val === null || val === undefined) return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    return n;
}

export function _moduleKey(name) {
    return 'stockApp_' + window.DATA_VERSION + '_' + name;
}
"@

$c1 = $c1.TrimEnd() + "`r`n" + $funcs + "`r`n"
[System.IO.File]::WriteAllText($f1, $c1, [System.Text.Encoding]::UTF8)
Write-Host "[OK] supabase-client.js: added getNumericVolume + _moduleKey"

# 2. In app-core.js, replace export function definitions with local references
$f2 = "C:\Users\jialeok\Desktop\biga-main\src\logic\app-core.js"
$c2 = [System.IO.File]::ReadAllText($f2, [System.Text.Encoding]::UTF8)

# Replace getNumericVolume definition
$c2 = $c2.Replace(
    "export function getNumericVolume(val) {`r`n            if (val === '' || val === null || val === undefined) return null;`r`n            const n = parseFloat(val);`r`n            if (isNaN(n)) return null;`r`n            return n; // 0 是合法的竞价量/成交量，不再视为 null`r`n        }",
    "const getNumericVolume = window.getNumericVolume;"
)

# Replace _moduleKey definition
$c2 = $c2.Replace(
    "export function _moduleKey(name) {`r`n            return 'stockApp_' + DATA_VERSION + '_' + name;`r`n        }",
    "const _moduleKey = window._moduleKey;"
)

[System.IO.File]::WriteAllText($f2, $c2, [System.Text.Encoding]::UTF8)
Write-Host "[OK] app-core.js: replaced definitions with local refs"

Write-Host "=== data-logic fix done ==="