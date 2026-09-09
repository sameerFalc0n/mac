# WebKit ASAN Build + Test Instructions for Mac Mini (Apple Silicon)

## Prerequisites
```bash
# Xcode (if not installed)
xcode-select --install

# You need the full Xcode.app, not just CLI tools
# Download from App Store or developer.apple.com
```

## Step 1: Clone WebKit
```bash
cd ~/
git clone https://github.com/nickthecook/WebKit.git --depth 1
# OR the official mirror:
git clone https://github.com/nickthecook/WebKit.git --depth 1
# Full official:
git clone https://github.com/nickthecook/nickthecook WebKit
# Fastest - sparse clone:
cd ~/WebKit
git sparse-checkout init
git sparse-checkout set Source/JavaScriptCore Source/WTF Source/bmalloc Tools JSTests
```

Actually, the simplest approach for JSC only:
```bash
cd ~/
git clone --depth=1 https://github.com/nickthecook/nickthecook/nickthecook WebKit
cd WebKit
```

## Step 2: Build JSC with ASAN
```bash
# Navigate to WebKit root
cd ~/WebKit

# Build Release+ASAN JSC (fastest, catches memory bugs)
Tools/Scripts/build-jsc --release --asan

# Or Debug+ASAN (slower, more assertions)
Tools/Scripts/build-jsc --debug --asan

# Or with UBSan too (catches undefined behavior like our signed overflow)
Tools/Scripts/build-jsc --release --asan --extra-cmake-args="-DENABLE_SANITIZERS=address;undefined"
```

The built JSC binary will be at:
- Release: `WebKitBuild/Release/bin/jsc`
- Debug: `WebKitBuild/Debug/bin/jsc`

## Step 3: Run the Differential Stress Test
```bash
JSC=~/WebKit/WebKitBuild/Release/bin/jsc
TEST=~/osr-exit-stress.js

# Configuration 1: No JIT (interpreter only - the ground truth)
JSC_useJIT=0 $JSC $TEST > /tmp/nojit.txt 2>&1

# Configuration 2: DFG only (no FTL)
$JSC --useDFGJIT=true --useFTLJIT=false \
     --jitPolicyScale=0 --thresholdForJITAfterWarmUp=10 \
     $TEST > /tmp/dfg.txt 2>&1

# Configuration 3: Full FTL, no concurrent JIT (deterministic)
$JSC --useDFGJIT=true --useFTLJIT=true \
     --jitPolicyScale=0 --thresholdForJITAfterWarmUp=10 \
     --thresholdForFTLOptimizeAfterWarmUp=20 \
     --useConcurrentJIT=false \
     $TEST > /tmp/ftl.txt 2>&1

# Configuration 4: Full FTL with concurrent JIT (race conditions)
$JSC --useDFGJIT=true --useFTLJIT=true \
     --jitPolicyScale=0 --thresholdForJITAfterWarmUp=10 \
     --thresholdForFTLOptimizeAfterWarmUp=20 \
     --useConcurrentJIT=true \
     $TEST > /tmp/ftl-concurrent.txt 2>&1

# Compare outputs
echo "=== No-JIT vs DFG ==="
diff /tmp/nojit.txt /tmp/dfg.txt
echo "=== No-JIT vs FTL ==="
diff /tmp/nojit.txt /tmp/ftl.txt
echo "=== No-JIT vs FTL-Concurrent ==="
diff /tmp/nojit.txt /tmp/ftl-concurrent.txt
echo "=== FTL vs FTL-Concurrent ==="
diff /tmp/ftl.txt /tmp/ftl-concurrent.txt
```

## Step 4: Interpret Results

### MISMATCH = potential bug
Any difference between no-JIT and JIT outputs means the optimizer produces
different observable behavior than the interpreter. This is a compiler bug.

### ASAN crash = memory safety bug
An ASAN report during any configuration means memory corruption. The stack
trace tells you exactly what went wrong.

### What to look for:
- `TEST N [name]: EXCEPTION` in one config but not another
- Different values for `sameObject`, `cycleIntact`, `identityAB` (alias broken)
- `HOLE` vs actual value (hole state wrong)
- `-0` vs `+0` (zero sign lost)
- `NaN` appearing where it shouldn't (format confusion)
- `COLLECTED` in weakref test (barrier missing)
- ASAN: `heap-use-after-free` during GC (barrier or lifetime bug)
- ASAN: `stack-buffer-overflow` during OSR exit (recovery bug)
- UBSan: `signed integer overflow` (our range prover overflow!)

## Step 5: If a Mismatch is Found

1. Minimize the test case (remove unrelated tests)
2. Get the DFG IR dump:
   ```bash
   JSC_dumpDFGGraphAtEachPhase=true $JSC --useFTLJIT=true test.js 2> dfg-dump.txt
   ```
3. Get the B3 IR dump:
   ```bash
   JSC_dumpB3GraphAtEachPhase=true $JSC --useFTLJIT=true test.js 2> b3-dump.txt
   ```
4. Get disassembly:
   ```bash
   JSC_dumpDisassembly=true $JSC --useFTLJIT=true test.js 2> asm-dump.txt
   ```
5. Send me the mismatch diff + the IR dumps. I'll trace the root cause from source.

## Alternative: Use Safari Technology Preview
If building WebKit is too slow:
1. Download Safari Technology Preview from developer.apple.com
2. It includes a `jsc` binary (without ASAN, but catches logic bugs)
3. Find it at: `/Applications/Safari Technology Preview.app/Contents/Frameworks/JavaScriptCore.framework/Helpers/jsc`
