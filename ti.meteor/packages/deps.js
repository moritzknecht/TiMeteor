(function () {

/* Imports */
//var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var Deps;

(function () {

//////////////////////////////////////////////////////////////////////////////////
//                                                                              //
// packages/deps/deps.js                                                        //
//                                                                              //
//////////////////////////////////////////////////////////////////////////////////
                                                                                //
//////////////////////////////////////////////////                              // 1
// Package docs at http://docs.meteor.com/#deps //                              // 2
//////////////////////////////////////////////////                              // 3
                                                                                // 4
Deps = {};                                                                      // 5
                                                                                // 6
// http://docs.meteor.com/#deps_active                                          // 7
Deps.active = false;                                                            // 8
                                                                                // 9
// http://docs.meteor.com/#deps_currentcomputation                              // 10
Deps.currentComputation = null;                                                 // 11
                                                                                // 12
var setCurrentComputation = function (c) {                                      // 13
  Deps.currentComputation = c;                                                  // 14
  Deps.active = !! c;                                                           // 15
};                                                                              // 16
                                                                                // 17
var _debugFunc = function () {                                                  // 18
  // lazy evaluation because `Meteor` does not exist right away                 // 19
  return (typeof Meteor !== "undefined" ? Meteor._debug :                       // 20
          ((typeof console !== "undefined") && console.log ?                    // 21
           function () { console.log.apply(console, arguments); } :             // 22
           function () {}));                                                    // 23
};                                                                              // 24
                                                                                // 25
var _throwOrLog = function (from, e) {                                          // 26
  if (throwFirstError) {                                                        // 27
    throw e;                                                                    // 28
  } else {                                                                      // 29
    _debugFunc()("Exception from Deps " + from + " function:",                  // 30
                 e.stack || e.message);                                         // 31
  }                                                                             // 32
};                                                                              // 33
                                                                                // 34
// Takes a function `f`, and wraps it in a `Meteor._noYieldsAllowed`            // 35
// block if we are running on the server. On the client, returns the            // 36
// original function (since `Meteor._noYieldsAllowed` is a                      // 37
// no-op). This has the benefit of not adding an unnecessary stack              // 38
// frame on the client.                                                         // 39
var withNoYieldsAllowed = function (f) {                                        // 40
  if ((typeof Meteor === 'undefined') || Meteor.isClient) {                     // 41
    return f;                                                                   // 42
  } else {                                                                      // 43
    return function () {                                                        // 44
      var args = arguments;                                                     // 45
      Meteor._noYieldsAllowed(function () {                                     // 46
        f.apply(null, args);                                                    // 47
      });                                                                       // 48
    };                                                                          // 49
  }                                                                             // 50
};                                                                              // 51
                                                                                // 52
var nextId = 1;                                                                 // 53
// computations whose callbacks we should call at flush time                    // 54
var pendingComputations = [];                                                   // 55
// `true` if a Deps.flush is scheduled, or if we are in Deps.flush now          // 56
var willFlush = false;                                                          // 57
// `true` if we are in Deps.flush now                                           // 58
var inFlush = false;                                                            // 59
// `true` if we are computing a computation now, either first time              // 60
// or recompute.  This matches Deps.active unless we are inside                 // 61
// Deps.nonreactive, which nullfies currentComputation even though              // 62
// an enclosing computation may still be running.                               // 63
var inCompute = false;                                                          // 64
// `true` if the `_throwFirstError` option was passed in to the call            // 65
// to Deps.flush that we are in. When set, throw rather than log the            // 66
// first error encountered while flushing. Before throwing the error,           // 67
// finish flushing (from a finally block), logging any subsequent               // 68
// errors.                                                                      // 69
var throwFirstError = false;                                                    // 70
                                                                                // 71
var afterFlushCallbacks = [];                                                   // 72
                                                                                // 73
var requireFlush = function () {                                                // 74
  if (! willFlush) {                                                            // 75
    setTimeout(Deps.flush, 0);                                                  // 76
    willFlush = true;                                                           // 77
  }                                                                             // 78
};                                                                              // 79
                                                                                // 80
// Deps.Computation constructor is visible but private                          // 81
// (throws an error if you try to call it)                                      // 82
var constructingComputation = false;                                            // 83
                                                                                // 84
//                                                                              // 85
// http://docs.meteor.com/#deps_computation                                     // 86
//                                                                              // 87
Deps.Computation = function (f, parent) {                                       // 88
  if (! constructingComputation)                                                // 89
    throw new Error(                                                            // 90
      "Deps.Computation constructor is private; use Deps.autorun");             // 91
  constructingComputation = false;                                              // 92
                                                                                // 93
  var self = this;                                                              // 94
                                                                                // 95
  // http://docs.meteor.com/#computation_stopped                                // 96
  self.stopped = false;                                                         // 97
                                                                                // 98
  // http://docs.meteor.com/#computation_invalidated                            // 99
  self.invalidated = false;                                                     // 100
                                                                                // 101
  // http://docs.meteor.com/#computation_firstrun                               // 102
  self.firstRun = true;                                                         // 103
                                                                                // 104
  self._id = nextId++;                                                          // 105
  self._onInvalidateCallbacks = [];                                             // 106
  // the plan is at some point to use the parent relation                       // 107
  // to constrain the order that computations are processed                     // 108
  self._parent = parent;                                                        // 109
  self._func = f;                                                               // 110
  self._recomputing = false;                                                    // 111
                                                                                // 112
  var errored = true;                                                           // 113
  try {                                                                         // 114
    self._compute();                                                            // 115
    errored = false;                                                            // 116
  } finally {                                                                   // 117
    self.firstRun = false;                                                      // 118
    if (errored)                                                                // 119
      self.stop();                                                              // 120
  }                                                                             // 121
};                                                                              // 122
                                                                                // 123
// http://docs.meteor.com/#computation_oninvalidate                             // 124
Deps.Computation.prototype.onInvalidate = function (f) {                        // 125
  var self = this;                                                              // 126
                                                                                // 127
  if (typeof f !== 'function')                                                  // 128
    throw new Error("onInvalidate requires a function");                        // 129
                                                                                // 130
  if (self.invalidated) {                                                       // 131
    Deps.nonreactive(function () {                                              // 132
      withNoYieldsAllowed(f)(self);                                             // 133
    });                                                                         // 134
  } else {                                                                      // 135
    self._onInvalidateCallbacks.push(f);                                        // 136
  }                                                                             // 137
};                                                                              // 138
                                                                                // 139
// http://docs.meteor.com/#computation_invalidate                               // 140
Deps.Computation.prototype.invalidate = function () {                           // 141
  var self = this;                                                              // 142
  if (! self.invalidated) {                                                     // 143
    // if we're currently in _recompute(), don't enqueue                        // 144
    // ourselves, since we'll rerun immediately anyway.                         // 145
    if (! self._recomputing && ! self.stopped) {                                // 146
      requireFlush();                                                           // 147
      pendingComputations.push(this);                                           // 148
    }                                                                           // 149
                                                                                // 150
    self.invalidated = true;                                                    // 151
                                                                                // 152
    // callbacks can't add callbacks, because                                   // 153
    // self.invalidated === true.                                               // 154
    for(var i = 0, f; f = self._onInvalidateCallbacks[i]; i++) {                // 155
      Deps.nonreactive(function () {                                            // 156
        withNoYieldsAllowed(f)(self);                                           // 157
      });                                                                       // 158
    }                                                                           // 159
    self._onInvalidateCallbacks = [];                                           // 160
  }                                                                             // 161
};                                                                              // 162
                                                                                // 163
// http://docs.meteor.com/#computation_stop                                     // 164
Deps.Computation.prototype.stop = function () {                                 // 165
  if (! this.stopped) {                                                         // 166
    this.stopped = true;                                                        // 167
    this.invalidate();                                                          // 168
  }                                                                             // 169
};                                                                              // 170
                                                                                // 171
Deps.Computation.prototype._compute = function () {                             // 172
  var self = this;                                                              // 173
  self.invalidated = false;                                                     // 174
                                                                                // 175
  var previous = Deps.currentComputation;                                       // 176
  setCurrentComputation(self);                                                  // 177
  var previousInCompute = inCompute;                                            // 178
  inCompute = true;                                                             // 179
  try {                                                                         // 180
    withNoYieldsAllowed(self._func)(self);                                      // 181
  } finally {                                                                   // 182
    setCurrentComputation(previous);                                            // 183
    inCompute = false;                                                          // 184
  }                                                                             // 185
};                                                                              // 186
                                                                                // 187
Deps.Computation.prototype._recompute = function () {                           // 188
  var self = this;                                                              // 189
                                                                                // 190
  self._recomputing = true;                                                     // 191
  try {                                                                         // 192
    while (self.invalidated && ! self.stopped) {                                // 193
      try {                                                                     // 194
        self._compute();                                                        // 195
      } catch (e) {                                                             // 196
        _throwOrLog("recompute", e);                                            // 197
      }                                                                         // 198
      // If _compute() invalidated us, we run again immediately.                // 199
      // A computation that invalidates itself indefinitely is an               // 200
      // infinite loop, of course.                                              // 201
      //                                                                        // 202
      // We could put an iteration counter here and catch run-away              // 203
      // loops.                                                                 // 204
    }                                                                           // 205
  } finally {                                                                   // 206
    self._recomputing = false;                                                  // 207
  }                                                                             // 208
};                                                                              // 209
                                                                                // 210
//                                                                              // 211
// http://docs.meteor.com/#deps_dependency                                      // 212
//                                                                              // 213
Deps.Dependency = function () {                                                 // 214
  this._dependentsById = {};                                                    // 215
};                                                                              // 216
                                                                                // 217
// http://docs.meteor.com/#dependency_depend                                    // 218
//                                                                              // 219
// Adds `computation` to this set if it is not already                          // 220
// present.  Returns true if `computation` is a new member of the set.          // 221
// If no argument, defaults to currentComputation, or does nothing              // 222
// if there is no currentComputation.                                           // 223
Deps.Dependency.prototype.depend = function (computation) {                     // 224
  if (! computation) {                                                          // 225
    if (! Deps.active)                                                          // 226
      return false;                                                             // 227
                                                                                // 228
    computation = Deps.currentComputation;                                      // 229
  }                                                                             // 230
  var self = this;                                                              // 231
  var id = computation._id;                                                     // 232
  if (! (id in self._dependentsById)) {                                         // 233
    self._dependentsById[id] = computation;                                     // 234
    computation.onInvalidate(function () {                                      // 235
      delete self._dependentsById[id];                                          // 236
    });                                                                         // 237
    return true;                                                                // 238
  }                                                                             // 239
  return false;                                                                 // 240
};                                                                              // 241
                                                                                // 242
// http://docs.meteor.com/#dependency_changed                                   // 243
Deps.Dependency.prototype.changed = function () {                               // 244
  var self = this;                                                              // 245
  for (var id in self._dependentsById)                                          // 246
    self._dependentsById[id].invalidate();                                      // 247
};                                                                              // 248
                                                                                // 249
// http://docs.meteor.com/#dependency_hasdependents                             // 250
Deps.Dependency.prototype.hasDependents = function () {                         // 251
  var self = this;                                                              // 252
  for(var id in self._dependentsById)                                           // 253
    return true;                                                                // 254
  return false;                                                                 // 255
};                                                                              // 256
                                                                                // 257
// http://docs.meteor.com/#deps_flush                                           // 258
Deps.flush = function (_opts) {                                                 // 259
  // XXX What part of the comment below is still true? (We no longer            // 260
  // have Spark)                                                                // 261
  //                                                                            // 262
  // Nested flush could plausibly happen if, say, a flush causes                // 263
  // DOM mutation, which causes a "blur" event, which runs an                   // 264
  // app event handler that calls Deps.flush.  At the moment                    // 265
  // Spark blocks event handlers during DOM mutation anyway,                    // 266
  // because the LiveRange tree isn't valid.  And we don't have                 // 267
  // any useful notion of a nested flush.                                       // 268
  //                                                                            // 269
  // https://app.asana.com/0/159908330244/385138233856                          // 270
  if (inFlush)                                                                  // 271
    throw new Error("Can't call Deps.flush while flushing");                    // 272
                                                                                // 273
  if (inCompute)                                                                // 274
    throw new Error("Can't flush inside Deps.autorun");                         // 275
                                                                                // 276
  inFlush = true;                                                               // 277
  willFlush = true;                                                             // 278
  throwFirstError = !! (_opts && _opts._throwFirstError);                       // 279
                                                                                // 280
  var finishedTry = false;                                                      // 281
  try {                                                                         // 282
    while (pendingComputations.length ||                                        // 283
           afterFlushCallbacks.length) {                                        // 284
                                                                                // 285
      // recompute all pending computations                                     // 286
      while (pendingComputations.length) {                                      // 287
        var comp = pendingComputations.shift();                                 // 288
        comp._recompute();                                                      // 289
      }                                                                         // 290
                                                                                // 291
      if (afterFlushCallbacks.length) {                                         // 292
        // call one afterFlush callback, which may                              // 293
        // invalidate more computations                                         // 294
        var func = afterFlushCallbacks.shift();                                 // 295
        try {                                                                   // 296
          func();                                                               // 297
        } catch (e) {                                                           // 298
          _throwOrLog("afterFlush function", e);                                // 299
        }                                                                       // 300
      }                                                                         // 301
    }                                                                           // 302
    finishedTry = true;                                                         // 303
  } finally {                                                                   // 304
    if (! finishedTry) {                                                        // 305
      // we're erroring                                                         // 306
      inFlush = false; // needed before calling `Deps.flush()` again            // 307
      Deps.flush({_throwFirstError: false}); // finish flushing                 // 308
    }                                                                           // 309
    willFlush = false;                                                          // 310
    inFlush = false;                                                            // 311
  }                                                                             // 312
};                                                                              // 313
                                                                                // 314
// http://docs.meteor.com/#deps_autorun                                         // 315
//                                                                              // 316
// Run f(). Record its dependencies. Rerun it whenever the                      // 317
// dependencies change.                                                         // 318
//                                                                              // 319
// Returns a new Computation, which is also passed to f.                        // 320
//                                                                              // 321
// Links the computation to the current computation                             // 322
// so that it is stopped if the current computation is invalidated.             // 323
Deps.autorun = function (f) {                                                   // 324
  if (typeof f !== 'function')                                                  // 325
    throw new Error('Deps.autorun requires a function argument');               // 326
                                                                                // 327
  constructingComputation = true;                                               // 328
  var c = new Deps.Computation(f, Deps.currentComputation);                     // 329
                                                                                // 330
  if (Deps.active)                                                              // 331
    Deps.onInvalidate(function () {                                             // 332
      c.stop();                                                                 // 333
    });                                                                         // 334
                                                                                // 335
  return c;                                                                     // 336
};                                                                              // 337
                                                                                // 338
// http://docs.meteor.com/#deps_nonreactive                                     // 339
//                                                                              // 340
// Run `f` with no current computation, returning the return value              // 341
// of `f`.  Used to turn off reactivity for the duration of `f`,                // 342
// so that reactive data sources accessed by `f` will not result in any         // 343
// computations being invalidated.                                              // 344
Deps.nonreactive = function (f) {                                               // 345
  var previous = Deps.currentComputation;                                       // 346
  setCurrentComputation(null);                                                  // 347
  try {                                                                         // 348
    return f();                                                                 // 349
  } finally {                                                                   // 350
    setCurrentComputation(previous);                                            // 351
  }                                                                             // 352
};                                                                              // 353
                                                                                // 354
// http://docs.meteor.com/#deps_oninvalidate                                    // 355
Deps.onInvalidate = function (f) {                                              // 356
  if (! Deps.active)                                                            // 357
    throw new Error("Deps.onInvalidate requires a currentComputation");         // 358
                                                                                // 359
  Deps.currentComputation.onInvalidate(f);                                      // 360
};                                                                              // 361
                                                                                // 362
// http://docs.meteor.com/#deps_afterflush                                      // 363
Deps.afterFlush = function (f) {                                                // 364
  afterFlushCallbacks.push(f);                                                  // 365
  requireFlush();                                                               // 366
};                                                                              // 367
                                                                                // 368
//////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

//////////////////////////////////////////////////////////////////////////////////
//                                                                              //
// packages/deps/deprecated.js                                                  //
//                                                                              //
//////////////////////////////////////////////////////////////////////////////////
                                                                                //
// Deprecated (Deps-recated?) functions.                                        // 1
                                                                                // 2
// These functions used to be on the Meteor object (and worked slightly         // 3
// differently).                                                                // 4
// XXX COMPAT WITH 0.5.7                                                        // 5
Meteor.flush = Deps.flush;                                                      // 6
Meteor.autorun = Deps.autorun;                                                  // 7
                                                                                // 8
// We used to require a special "autosubscribe" call to reactively subscribe to // 9
// things. Now, it works with autorun.                                          // 10
// XXX COMPAT WITH 0.5.4                                                        // 11
Meteor.autosubscribe = Deps.autorun;                                            // 12
                                                                                // 13
// This Deps API briefly existed in 0.5.8 and 0.5.9                             // 14
// XXX COMPAT WITH 0.5.9                                                        // 15
Deps.depend = function (d) {                                                    // 16
  return d.depend();                                                            // 17
};                                                                              // 18
                                                                                // 19
//////////////////////////////////////////////////////////////////////////////////

}).call(this);

exports.Deps = Deps;

})();



//# sourceMappingURL=d9b2b2601bdab0f57291b38e7974a7190b8aac01.map
