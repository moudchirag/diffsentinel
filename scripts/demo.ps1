# DiffSentinel screen-recording script (Windows PowerShell 5.1+).
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1            # full demo (live Gemini, max 3 requests)
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1 -Rehearse  # free: uses the mock model, no API calls
# Press Enter between steps so you can narrate. Never displays .env.
param(
  [switch]$Rehearse,
  [switch]$NoPause,
  [switch]$SkipTests
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$repo = ".diff-sentinel/demo-repo"
$out = ".diff-sentinel/review.json"

function Step([string]$title) {
  Write-Host ""
  Write-Host ("=" * 78) -ForegroundColor DarkCyan
  Write-Host "  $title" -ForegroundColor Cyan
  Write-Host ("=" * 78) -ForegroundColor DarkCyan
}
function Show([string]$cmd) { Write-Host "PS> $cmd" -ForegroundColor Yellow }
function Next {
  if (-not $NoPause) { Write-Host ""; Read-Host "  [Enter] next step" | Out-Null }
}

Clear-Host
Step "DiffSentinel - read-only, tool-using AI code-review agent"
Write-Host "  TypeScript + Gemini manual function calling + Zod. Reviews a git diff, a branch or a PR."
Write-Host "  Demo repo: a synthetic banking app with a 'feature/receipts' branch that hides 6 bugs."
npm run demo:setup -- branch *> $null
Next

Step "1. The change under review (branch vs main, like a PR)"
Show "git log --oneline main..HEAD"
git -C $repo log --oneline main..HEAD
Show "git status --short"
git -C $repo status --short
Show "git diff main -- src/transfer.ts"
git -C $repo --no-pager diff main -- src/transfer.ts
Next

Step "2. Guardrails, offline (scripted mock model, no API call, no analysis)"
Write-Host "  Watch: parallel tool calls in one turn, and the '../../etc/passwd' read being blocked." -ForegroundColor DarkGray
Show "npm run dev -- review --cwd $repo --base main --provider mock   (trace only)"
# The trace goes to stderr; the (empty) mock report on stdout is discarded to keep this step short.
npm run dev --silent -- review --cwd $repo --base main --provider mock --format json > $null
Next

if ($Rehearse) {
  Step "3. AI review (REHEARSAL: mock model again, no API call)"
  Show "npm run dev -- review --cwd $repo --base main --provider mock --out $out"
  npm run dev --silent -- review --cwd $repo --base main --intent "Send transfer receipts by email" --provider mock --out $out
} else {
  Step "3. Real AI review with Gemini (whole branch, max 3 API requests)"
  Show "npm run dev -- review --cwd $repo --base main --intent `"Send transfer receipts by email`" --max-calls 3 --out $out"
  npm run dev --silent -- review --cwd $repo --base main --intent "Send transfer receipts by email" --max-calls 3 --out $out
}
Next

Step "4. Structured JSON output (Zod-validated; risk and coverage computed in code)"
if (Test-Path $out) {
  $r = Get-Content $out -Raw | ConvertFrom-Json
  Write-Host ("  overallRisk: {0}   findings: {1}   missingTests: {2}   styleIssues: {3}   partial: {4}" -f `
    $r.overallRisk, @($r.findings).Count, @($r.missingTests).Count, @($r.styleIssues).Count, $r.coverage.isPartial)
  Write-Host ("  model: {0}   turns: {1}   tool calls: {2}   API requests: {3}" -f `
    $r.meta.model, $r.meta.agentTurns, @($r.meta.toolCalls).Count, $(if ($null -ne $r.meta.apiRequests) { $r.meta.apiRequests } else { "n/a" }))
  if (@($r.findings).Count -gt 0) {
    $r.findings | Select-Object severity, category, file,
      @{ n = "lines"; e = { if ($_.lineStart) { "$($_.lineStart)-$($_.lineEnd)" } else { "-" } } },
      title | Format-Table -AutoSize -Wrap
  }
} else {
  Write-Host "  No report written (the review did not complete)." -ForegroundColor Red
}
Next

if (-not $SkipTests) {
  Step "5. Automated tests (fake model, no network)"
  Show "npm test"
  npm test 2>&1 | Select-String -Pattern "Test Files|Tests "
}

Step "Done. Code, README and evaluation: github.com/moudchirag/diffsentinel"
