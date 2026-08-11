# Bundle each Cloudflare Worker into a single self-contained .js file
# Usage: powershell -ExecutionPolicy Bypass -File _bundle-workers.ps1

$workersRoot = "C:\Users\jialeok\Desktop\biga-main\workers"
$outDir = Join-Path $workersRoot "_bundled"
if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function Resolve-ImportPath($importPath, $currentFileDir, $workersRoot) {
    # Resolve relative paths like ./config.js, ../data/fuyao-api.js, ../../_shared-source/date-utils.js
    $full = [System.IO.Path]::GetFullPath((Join-Path $currentFileDir $importPath))
    return $full
}

function Get-AllDeps($entryFile, $workersRoot) {
    $visited = [System.Collections.Generic.Dictionary[string, object]]::new()
    $order = [System.Collections.Generic.List[string]]::new()

    function Visit-File($filePath, $visited, $order, $workersRoot) {
        $normalized = $filePath.Replace('\', '/').ToLower()
        if ($visited.ContainsKey($normalized)) { return }
        $visited[$normalized] = $true

        $content = [System.IO.File]::ReadAllText($filePath)
        $fileDir = [System.IO.Path]::GetDirectoryName($filePath)

        # Find all import statements
        $importRegex = [regex]'import\s+(?:\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+[''"]([^''"]+)[''"]'
        $matches = $importRegex.Matches($content)

        foreach ($m in $matches) {
            $importPath = $m.Groups[1].Value
            $resolved = Resolve-ImportPath $importPath $fileDir $workersRoot
            if (Test-Path $resolved) {
                Visit-File $resolved $visited $order $workersRoot
            }
        }

        $order.Add($filePath)
    }

    Visit-File $entryFile $visited $order $workersRoot
    return $order
}

function Strip-And-Clean($content) {
    $lines = $content -split "`r?`n"
    $result = [System.Collections.Generic.List[string]]::new()

    foreach ($line in $lines) {
        # Skip import lines
        if ($line -match '^\s*import\s+') { continue }

        # Strip export keyword but keep the declaration
        $cleaned = $line
        $cleaned = $cleaned -replace '^\s*export\s+function\s', 'function '
        $cleaned = $cleaned -replace '^\s*export\s+const\s', 'const '
        $cleaned = $cleaned -replace '^\s*export\s+let\s', 'let '
        $cleaned = $cleaned -replace '^\s*export\s+class\s', 'class '
        $cleaned = $cleaned -replace '^\s*export\s+async\s+function\s', 'async function '

        $result.Add($cleaned)
    }

    return ($result -join "`n")
}

$workers = @(
    @{ Name = "bidding-auto-fetch"; Dir = "bidding-auto-fetch" },
    @{ Name = "bidding-board-worker-a"; Dir = "bidding-board-worker-a" },
    @{ Name = "bidding-board-worker-b"; Dir = "bidding-board-worker-b" }
)

foreach ($w in $workers) {
    $entryFile = Join-Path $workersRoot "$($w.Dir)\index.js"
    $outFile = Join-Path $outDir "$($w.Name).js"

    Write-Host "Bundling $($w.Name)..." -ForegroundColor Cyan

    $depOrder = Get-AllDeps $entryFile $workersRoot

    $bundled = [System.Collections.Generic.List[string]]::new()
    $bundled.Add("// ===== $($w.Name) — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====")
    $bundled.Add("// 生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $bundled.Add("// 注意: 此文件由 _bundle-workers.ps1 自动生成，请勿手动编辑")
    $bundled.Add("")

    foreach ($dep in $depOrder) {
        $relativeName = $dep.Replace($workersRoot + '\', '').Replace('\', '/')
        $content = [System.IO.File]::ReadAllText($dep)
        $cleaned = Strip-And-Clean $content

        $bundled.Add("// ────── $relativeName ──────")
        $bundled.Add($cleaned)
        $bundled.Add("")
    }

    $finalContent = ($bundled -join "`n")
    [System.IO.File]::WriteAllText($outFile, $finalContent, [System.Text.UTF8Encoding]::new($false))

    $lineCount = ($finalContent -split "`n").Count
    Write-Host "  → $outFile ($lineCount lines)" -ForegroundColor Green
}

Write-Host "`nDone! Bundled files in: $outDir" -ForegroundColor Yellow