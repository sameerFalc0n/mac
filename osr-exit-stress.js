// WebKit JSC Differential OSR Exit Stress Test
// Based on brain's "THE ONE TEST TO RUN" prescription
// Run on Mac Mini with: 
//   JSC_useJIT=0 jsc osr-exit-stress.js > nojit.txt
//   jsc --useDFGJIT=true --useFTLJIT=false --jitPolicyScale=0 osr-exit-stress.js > dfg.txt
//   jsc --useDFGJIT=true --useFTLJIT=true --jitPolicyScale=0 --useConcurrentJIT=false osr-exit-stress.js > ftl.txt
//   diff nojit.txt dfg.txt && diff nojit.txt ftl.txt
//
// A MISMATCH between any two outputs is a potential bug.
// Run under ASAN: jsc --useFTLJIT=true --jitPolicyScale=0 osr-exit-stress.js
// (build WebKit with --asan flag)

"use strict";

// ============================================================
// SEED INFRASTRUCTURE
// ============================================================

let testId = 0;
function test(name, fn) {
    testId++;
    try {
        const result = fn();
        print(`TEST ${testId} [${name}]: ${canonicalize(result)}`);
    } catch (e) {
        print(`TEST ${testId} [${name}]: EXCEPTION ${e.message}`);
    }
}

// Canonicalize without JSON (JSON hides NaN, -0, holes, identity)
function canonicalize(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "number") {
        if (Object.is(v, -0)) return "-0";
        if (Object.is(v, NaN)) return "NaN";
        return String(v);
    }
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) {
        let parts = [];
        for (let i = 0; i < v.length; i++) {
            if (!(i in v)) parts.push("HOLE");
            else parts.push(canonicalize(v[i]));
        }
        return `[${parts.join(",")}]`;
    }
    if (typeof v === "object") {
        let keys = Object.getOwnPropertyNames(v).sort();
        let parts = keys.map(k => `${k}:${canonicalize(v[k])}`);
        return `{${parts.join(",")}}`;
    }
    return String(v);
}

// Force GC if available
function gc_pressure() {
    if (typeof gc === "function") gc();
    // Also allocate and discard to create pressure
    for (let i = 0; i < 1000; i++) { let x = {a: i, b: [i]}; }
}

// ============================================================
// TEST 1: Int32 -> Int52 OSR exit with sunk allocation
// The function allocates an object, writes to it, then on one
// iteration the value exceeds Int32 range, forcing an exit.
// The sunk allocation must materialize with correct fields.
// ============================================================
test("int32-to-int52-sunk-object", function() {
    function make(n) {
        let obj = {x: n, y: n + 1, child: null};
        let alias = obj; // Two references to same object
        obj.child = {val: n * 2};
        alias.z = n + 2; // Write through alias
        // On most iterations: n is small Int32
        // On trigger iteration: n is 2^40, forcing Int52
        if (n > 1000000000000) {
            gc_pressure();
            return {
                x: obj.x,
                y: obj.y,
                z: obj.z,
                childVal: obj.child.val,
                sameObject: obj === alias,
                typeofX: typeof obj.x
            };
        }
        return null;
    }
    // Warm up with Int32
    for (let i = 0; i < 100000; i++) make(i);
    // Trigger with Int52
    return make(1099511627776); // 2^40
});

// ============================================================
// TEST 2: Double/NaN purification during OSR exit
// Allocate an object with double fields, exit when NaN appears.
// Check that NaN is properly purified (not confused with pointer).
// ============================================================
test("double-nan-purification", function() {
    function compute(a, b) {
        let result = {value: a / b, raw: a, divisor: b};
        let copy = result; // alias
        result.sum = a + b;
        if (b === 0) {
            gc_pressure();
            return {
                value: Object.is(result.value, Infinity) ? "Inf" : 
                       Object.is(result.value, -Infinity) ? "-Inf" :
                       Object.is(result.value, NaN) ? "NaN" : String(result.value),
                isNaN: isNaN(result.value),
                sameObject: result === copy,
                sum: result.sum,
                typeofValue: typeof result.value
            };
        }
        return null;
    }
    for (let i = 1; i < 100000; i++) compute(i, i);
    return compute(0, 0); // 0/0 = NaN
});

// ============================================================
// TEST 3: Positive zero vs negative zero
// The optimizer may fold 0 to a constant. Negative zero
// must survive OSR exit correctly.
// ============================================================
test("negative-zero-preservation", function() {
    function check(x) {
        let obj = {val: x * 0, orig: x}; // x * 0 = +0 or -0
        if (x < 0 && x > -2) {
            gc_pressure();
            return {
                isNegZero: Object.is(obj.val, -0),
                val: Object.is(obj.val, -0) ? "-0" : "+0",
                orig: obj.orig
            };
        }
        return null;
    }
    for (let i = 1; i < 100000; i++) check(i);
    return check(-1); // -1 * 0 = -0
});

// ============================================================  
// TEST 4: Structure transition during sunk allocation
// Object starts with structure A, gains property -> structure B.
// The sunk allocation must materialize with the FINAL structure.
// ============================================================
test("structure-transition-sunk", function() {
    function morph(n) {
        let obj = {a: n};
        obj.b = n + 1; // transition A -> B
        if (n % 3 === 0) obj.c = n + 2; // sometimes transition B -> C
        let keys = null;
        if (n > 99998) {
            gc_pressure();
            keys = Object.getOwnPropertyNames(obj);
            return {
                keys: keys.sort().join(","),
                a: obj.a,
                b: obj.b,
                c: obj.c,
                hasC: "c" in obj
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) morph(i);
    return morph(99999);
});

// ============================================================
// TEST 5: Array with holes + storage mode transition
// Array starts packed, then gets a hole. OSR exit must
// preserve hole state correctly.
// ============================================================
test("array-holes-preservation", function() {
    function makeArr(n) {
        let arr = [n, n+1, n+2, n+3, n+4];
        if (n % 2 === 0) {
            delete arr[2]; // Create hole at index 2
        }
        if (n > 99998) {
            gc_pressure();
            return {
                length: arr.length,
                has0: 0 in arr,
                has2: 2 in arr,
                has4: 4 in arr,
                val0: arr[0],
                val2: 2 in arr ? arr[2] : "HOLE",
                val4: arr[4]
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) makeArr(i);
    return makeArr(100000);
});

// ============================================================
// TEST 6: Exception after sunk stores
// Throw an exception AFTER writing to a sunk object.
// The materialized object in the catch must have the writes.
// ============================================================
test("exception-after-sunk-store", function() {
    function inner(n, obj) {
        obj.x = n;
        obj.y = n * 2;
        obj.z = n * 3;
        if (n > 99998) throw obj;
        return obj.x + obj.y + obj.z;
    }
    function outer(n) {
        let obj = {x: 0, y: 0, z: 0};
        try {
            return inner(n, obj);
        } catch (e) {
            gc_pressure();
            return {
                x: e.x,
                y: e.y,
                z: e.z,
                isObj: e === obj
            };
        }
    }
    for (let i = 0; i < 100000; i++) outer(i);
    return outer(99999);
});

// ============================================================
// TEST 7: WeakRef survival across GC during OSR exit
// A weakly-referenced object must survive if it's still
// reachable through the materialized graph.
// ============================================================
test("weakref-survival-materialized", function() {
    function check(n) {
        let inner = {val: n};
        let weak = new WeakRef(inner);
        let holder = {ref: inner, weak: weak};
        if (n > 99998) {
            gc_pressure();
            let deref = holder.weak.deref();
            return {
                alive: deref !== undefined,
                sameObj: deref === holder.ref,
                val: deref ? deref.val : "COLLECTED"
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) check(i);
    return check(99999);
});

// ============================================================
// TEST 8: Rope string resolution across OSR exit
// Build a rope string, don't resolve it before the exit point.
// The materialized rope must resolve to the correct content.
// ============================================================
test("rope-string-resolution", function() {
    function build(prefix, n) {
        let s = prefix + n; // Creates a rope
        let obj = {str: s, len: s.length};
        if (n > 99998) {
            gc_pressure();
            return {
                str: obj.str,
                len: obj.len,
                charAt0: obj.str.charAt(0),
                actualLen: obj.str.length,
                lenMatch: obj.len === obj.str.length
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) build("prefix_", i);
    return build("prefix_", 99999);
});

// ============================================================
// TEST 9: Number-to-object type transition
// Most iterations: value is a number. Trigger iteration: object.
// This forces the FTL to exit when the type changes.
// ============================================================
test("number-to-object-exit", function() {
    function process(val) {
        let result = {input: val, doubled: val + val};
        if (typeof val === "object") {
            gc_pressure();
            return {
                inputType: typeof result.input,
                doubledType: typeof result.doubled,
                inputStr: canonicalize(result.input),
                doubledStr: canonicalize(result.doubled)
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) process(i);
    return process({x: 42}); // Object instead of number
});

// ============================================================
// TEST 10: Multi-field overwrite before sinking
// Write to the same field multiple times. Dead-store elimination
// should keep only the last write. Materialization must use it.
// ============================================================
test("multi-overwrite-sunk", function() {
    function overwrite(n) {
        let obj = {};
        obj.val = 1;       // Write 1 (should be dead-stored)
        obj.val = n;       // Write 2 (should be dead-stored)  
        obj.val = n * 2;   // Write 3 (should be dead-stored)
        obj.val = n * 3;   // Write 4 (the one that matters)
        obj.other = obj.val + 1;
        if (n > 99998) {
            gc_pressure();
            return {
                val: obj.val,
                other: obj.other,
                expected: n * 3,
                match: obj.val === n * 3
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) overwrite(i);
    return overwrite(99999);
});

// ============================================================
// TEST 11: Cyclic phantom objects
// Two objects that reference each other. Both must materialize
// with correct mutual references.
// ============================================================
test("cyclic-phantom-objects", function() {
    function cycle(n) {
        let a = {val: n, peer: null};
        let b = {val: n + 1, peer: null};
        a.peer = b;
        b.peer = a;
        if (n > 99998) {
            gc_pressure();
            return {
                aVal: a.val,
                bVal: b.val,
                aPeerVal: a.peer.val,
                bPeerVal: b.peer.val,
                cycleIntact: a.peer.peer === a && b.peer.peer === b,
                identityAB: a.peer === b,
                identityBA: b.peer === a
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) cycle(i);
    return cycle(99999);
});

// ============================================================
// TEST 12: Packed -> holey array conversion with double storage
// Array uses double storage, then gets a hole. The double NaN
// hole marker must not be confused with an actual NaN value.
// ============================================================
test("double-array-hole-vs-nan", function() {
    function make(n) {
        let arr = [1.1, 2.2, 3.3, 4.4, 5.5];
        arr[2] = n * 1.1; // Keep double storage
        if (n % 2 === 0) delete arr[3]; // Hole
        arr[1] = NaN; // Actual NaN (not a hole)
        if (n > 99998) {
            gc_pressure();
            return {
                len: arr.length,
                has1: 1 in arr, // Should be true (NaN is a value)
                has3: 3 in arr, // Should be false on even n (hole)
                val1IsNaN: isNaN(arr[1]),
                val1Type: typeof arr[1],
                val2: arr[2],
                holeState: (3 in arr) ? "VALUE" : "HOLE"
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) make(i);
    return make(100000);
});

// ============================================================
// TEST 13: GC old-to-young barrier test
// Create an old container, store a newly materialized young
// object into it. If the barrier is missing, GC may collect
// the young object.
// ============================================================
test("old-to-young-barrier", function() {
    // Create a container and let it age through GC cycles
    let container = {child: null, tag: "old"};
    for (let i = 0; i < 10; i++) gc_pressure();
    
    function store(n) {
        let young = {val: n}; // Freshly allocated = young gen
        container.child = young; // Old-to-young store needs barrier
        if (n > 99998) {
            gc_pressure(); // GC after store -- if barrier missing, young dies
            gc_pressure();
            gc_pressure();
            return {
                childAlive: container.child !== null && container.child !== undefined,
                childVal: container.child ? container.child.val : "DEAD",
                expected: n
            };
        }
        return null;
    }
    for (let i = 0; i < 100000; i++) store(i);
    return store(99999);
});

print("ALL TESTS COMPLETE");
