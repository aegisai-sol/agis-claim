// Shared emission vectors (copied verbatim from aegisai repo miner/tests/emission_schedule_vectors.json @1a40710).
// Python mine_emit.emitted_until and this JS ceiling must both reproduce these to the base unit.
export default {
 "genesis": 1761868800,
 "eraSeconds": 63072000,
 "rate0": "67383307965",
 "minePoolBase": "8500000000000000000",
 "cases": [
  {
   "offset": 0,
   "emittedUntil": "0"
  },
  {
   "offset": 1,
   "emittedUntil": "67383307965"
  },
  {
   "offset": 59,
   "emittedUntil": "3975615169935"
  },
  {
   "offset": 86400,
   "emittedUntil": "5821917808176000"
  },
  {
   "offset": 31536000,
   "emittedUntil": "2124999999984240000"
  },
  {
   "offset": 63071999,
   "emittedUntil": "4249999932585172035"
  },
  {
   "offset": 63072000,
   "emittedUntil": "4249999999968480000"
  },
  {
   "offset": 63072001,
   "emittedUntil": "4250000033660133982"
  },
  {
   "offset": 63084345,
   "emittedUntil": "4250415923436887790"
  },
  {
   "offset": 126144007,
   "emittedUntil": "6375000117841972937"
  },
  {
   "offset": 315360000,
   "emittedUntil": "8234374999800960000"
  },
  {
   "offset": 630720003,
   "emittedUntil": "8491699218529284033"
  },
  {
   "offset": 3973536000,
   "emittedUntil": "8499999998486304000"
  },
  {
   "offset": 4036608999,
   "emittedUntil": "8499999998486304000"
  },
  {
   "offset": 16083360000,
   "emittedUntil": "8499999998486304000"
  },
  {
   "offset": 16146432000,
   "emittedUntil": "8499999998486304000"
  },
  {
   "offset": 18921600000,
   "emittedUntil": "8499999998486304000"
  }
 ]
}
;
