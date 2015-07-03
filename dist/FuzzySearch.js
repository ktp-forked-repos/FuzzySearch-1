/**
 * @license FuzzySearch.js
 * Autocomplete suggestion engine using approximate string matching
 * https://github.com/jeancroy/FuzzySearch
 *
 * Copyright (c) 2015, Jean Christophe Roy
 * Licensed under The MIT License.
 * http://opensource.org/licenses/MIT
 */

(function () { 'use strict';

/**
 * @param options
 * @constructor
 */

function FuzzySearch(options) {

    if (options === undefined) options = {};
    if (!(this instanceof FuzzySearch)) return new FuzzySearch(options);
    FuzzySearch.setOptions(this, options, FuzzySearch.defaultOptions, _privates, true, this._optionsHook)

}

FuzzySearch.defaultOptions =
/** @lends {FuzzySearchOptions.prototype} */{

    //
    //  Scoring, include in result
    //

    minimum_match: 1.0,               // Minimum score to consider two token are not unrelated
    thresh_include: 2.0,              // To be a candidate, score of item must be at least this
    thresh_relative_to_best: 0.5,     // and be at least this fraction of the best score
    field_good_enough: 20,            // If a field have this score, stop searching other fields. (field score is before item related bonus)

    //
    //  Scoring, bonus
    //

    bonus_match_start: 0.5,          // Additional value per character in common prefix
    bonus_token_order: 2.0,          // Value of two token properly ordered
    bonus_position_decay: 0.7,       // Exponential decay for position bonus (smaller : more importance to first item)

    score_per_token: true,            // if true, split query&field in token, allow to match in different order
                                      // if false, bypass at least half the computation cost, very fast
                                      // also disable different token that score different field, because no more token!!

    score_test_fused: false,          // Try one extra match where we disregard token separation.
                                      // "oldman" match "old man"

    score_acronym: false,             // jrrt match against John Ronald Reuel Tolkien
    acronym_tok: " .,-:",

    //
    //  Output sort & transform
    //

    score_round: 0.1,                // Two item that have the same rounded score are sorted alphabetically
    output_limit: 0,                 // Return up to N result, 0 to disable

    sorter: compareResults,          // Function used to sort. See signature of Array.sort(sorter)
    normalize: normalize,            // Function used to transform string (lowercase, accents, etc)
    filter: null,                     // Select elements to be searched. (done before each search)

    /**@type {string|function({SearchResult})}*/
    output_map: "item",              // Transform the output, can be a function or a path string.
                                     // output_map="root" return SearchResult object, needed to see the score
                                     // output_map="root.item" return original object.
                                     // output_map="root.item.somefield" output a field of original object.
                                     // (root.) is optional.
                                     //
                                     // output_map=function(root){ return something(root.item) }
                                     // ^this get original object and apply something() on it.

    join_str: ", ",                   //String used to join array fields

    //
    //  Tokens options
    //

    token_query_min_length: 2,       // Avoid processing very small words, include greater or equal, in query
    token_field_min_length: 3,       // include greater or equal, in item field
    token_query_max_length: 64,      // Shorten large token to give more even performance.
    token_field_max_length: 64,      // Shorten large token to give more even performance.
    token_fused_max_length: 64,      // Shorten large token to give more even performance.

    //Do not attempt to match token too different in size: n/m = len(field_tok)/len(query_tok)
    token_min_rel_size: 0.6,         // Field token should contain query token. Reject field token that are too small.
    token_max_rel_size: 10,           // Large field token tend to match against everything. Ensure query is long enough to be specific.


    //
    //  Interactive - suggest as you type.
    //  Avoid doing search that will be discarded without being displayed
    //  This also help prevent lag/ temp freeze
    //

    interactive_debounce: 150,   // This is initial value. Will try to learn actual time cost. Set to 0 to disable.
    interactive_mult: 1.2,       // Overhead for variability and to allow other things to happens (like redraw, highlight ).
    interactive_burst: 3,        // Allow short burst, prevent flicker due to debounce suppression of a callback

    //
    // Data
    //

    source: [],
    keys: [],
    lazy: false  // when true, any refresh happens only when a user make a search, option stay put until changed.


};

var _privates =
/** @lends {FuzzySearch.prototype} */{

    tags: [],     // alternative name for each key, support ouput alias and per key search
    index: [],    // source is processed using keys, then stored here
    tags_re: null,
    acro_re: null,

    /**@type {FuzzySearchOptions}*/
    options:null,
    dirty: false, // when true, schedule a source refresh using new or existing source & keys, used once then clear itself.

    //Information on last search
    query: null,
    results: [],
    start_time: 0,
    search_time: 0

};

/**
 * Number of bit in a int.
 * DEBUG-tip: setting this to zero will force "long string" algorithm for everything!
 * @const
 */
var INT_SIZE = 32;

function FuzzySearchOptions(defaults,options){
    for (var key in defaults) {
        if (defaults.hasOwnProperty(key)) { //fill self with value from either options or default
            this[key] = (options.hasOwnProperty(key) && options[key] !== undefined ) ? options[key] : defaults[key];
        }
    }
}

FuzzySearchOptions.update = function(self, defaults,options){
    for (var key in options) {
        if (options.hasOwnProperty(key) && defaults.hasOwnProperty(key)) {
            //explicitly set a options to undefined => reset default, else get value
            self[key] = (options[key] === undefined) ? defaults[key] : options[key];
        }
    }
};

/**
 * Set property of object,
 * Restrict properties that can be set from a list of available defaults.
 *
 * @param {FuzzySearch} self
 * @param {Object} options
 * @param {Object} defaults
 * @param {Object} privates
 * @param {boolean} reset
 * @param {function({Object})} hook
 *
 */
FuzzySearch.setOptions = function (self, options, defaults, privates, reset, hook) {

    if (reset) {
        extend(self,privates);
        self.options = new FuzzySearchOptions(defaults,options);
    } else {
        FuzzySearchOptions.update(self.options,defaults, options);
    }

    hook.call(self, options)
};

function extend(a, b) {
    for (var key in b) if (b.hasOwnProperty(key)) a[key] = b[key];
}


//
// - - - - - - - - - - - -
// SET & PARSE SETTINGS
// - - - - - - - - - - - -
//

extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {

    /**
     * Allow to change options after the object has been created.
     * If source is changed, new source is indexed.
     *
     * Optional reset allow to change any setting not in options to defaults.
     * This is similar to creating new object, but using same pointer.
     *
     * @param {Object} options
     * @param {boolean=} reset
     */

    setOptions: function (options, reset) {
        if (reset === undefined) reset = options.reset || false;
        FuzzySearch.setOptions(this, options, FuzzySearch.defaultOptions, _privates, reset, this._optionsHook);
    },

    /**
     *
     * @param {Object} options
     * @private
     */

    _optionsHook: function (options) {

        //Items of options have been copied into this.options
        //We still test "optioname in option" to know if we have received something new
        //This allow to support "shorthand" options and is used to refresh data.

        var selfopt = this.options;

        //Output stage
        if ("output_map" in options && typeof options.output_map === "string") {
            if (selfopt.output_map === "alias") selfopt.output_map = this.aliasResult;
            else selfopt.output_map = removePrefix(selfopt.output_map, ["root", "."]);
        }

        this.source = selfopt.source;

        // Input stage, work to allow different syntax for keys definition is done here.
        var oKeys;
        if (("keys" in options) && ( ( oKeys = options.keys) !== undefined)) {

            var key_type = Object.prototype.toString.call(oKeys);
            var key_index, nb_keys;

            this.tags = null;

            if (key_type === "[object String]") {
                this.keys = oKeys.length ? [oKeys] : [];
            }

            else if (key_type === "[object Object]") {

                this.keys = [];
                this.tags = []; //we don't know the "length" of dictionary
                key_index = 0;
                for (var tag in oKeys) {
                    if (oKeys.hasOwnProperty(tag)) {
                        this.tags[key_index] = tag;
                        this.keys[key_index] = oKeys[tag];
                        key_index++;
                    }
                }

            }

            else{
                this.keys = oKeys;
            }

            oKeys = this.keys;
            nb_keys = oKeys.length;
            for (key_index = -1; ++key_index < nb_keys;) {
                oKeys[key_index] = removePrefix(oKeys[key_index], ["item", "."])
            }

            if (!this.tags) this.tags = oKeys;
            this.tags_re = buildTagsRE(this.tags);

        }

        if (this.acro_re == null || "acronym_tok" in options) {
            this.acro_re = buildAcronymRE(selfopt.acronym_tok);
        }


        // Build cache
        if ( options.dirty || ("source" in options) || ("keys" in options)) {
            if (selfopt.lazy) this.dirty = true; //Schedule later.
            else {
                this._prepSource(this.source, this.keys, true);
                this.dirty = false;
            }
        }

    }

});

/**
 * Removes optional prefix of paths.
 * for example "root.", "."
 *
 * @param {string} str - input
 * @param {Array<string>} prefixes to remove
 * @returns {string}
 */

function removePrefix(str, prefixes) {
    var n = prefixes.length;
    var offset = 0;

    for (var i = -1; ++i < n;) {
        var p = prefixes[i], l = p.length;
        if (str.substr(offset, l) === p) offset += l;
    }

    return (offset > 0) ? str.substr(offset) : str;
}

function buildTagsRE(tags) {

    var n = tags.length;
    if (!n) return null;

    var tag_str = re_escape(tags[0]);
    for (var i = 0; ++i < n;) {
        tag_str += "|" + re_escape(tags[i]);
    }

    return new RegExp("(?:^|\\s)\\s*(" + tag_str + "):\\s*", "g");

}

function buildAcronymRE(sep) {

    var n = sep.length;
    if (!n) return null;
    var acro_str = re_escape(sep);
    return new RegExp("(?:^|[" + acro_str + "])+([^" + acro_str + "])[^" + acro_str + "]*", "g");

}

// Build regexp for tagged search
function re_escape(str) {
    var re = /[\-\[\]\/\{}\(\)\*\+\?\.\\\^\$\|]/g;
    return str.replace(re, "\\$&");
}
//
// - - - - - - - - - - - -
//  OUTPUT OR POST PROCESS
// - - - - - - - - - - - -
//

extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {

    /**
     * Given a SearchResult object, recover the value of the best matching field.
     * This is done on demand for display.
     *
     * @param {SearchResult} result
     * @return {string} original field
     */

    getMatchingField: function (result) {
        var f = FuzzySearch.generateFields(result.item, [this.keys[result.matchIndex]]);
        return f[0][result.subIndex];
    },

    /**
     * Given a SearchResult object, generate a new object that follow alias structure
     * @param {SearchResult} result
     * @return {*} aliased result
     */

    aliasResult: function (result) {

        var options = this.options;
        var f = FuzzySearch.generateFields(result.item, this.keys);
        var out = {}, tags = this.tags, join_str = options.join_str;

        for (var i = -1, n = f.length; ++i < n;) {
            out[tags[i]] = f[i].join(join_str)
        }

        out._item = result.item;
        out._score = result.score;
        out._match = f[result.matchIndex][result.subIndex];

        return out;

    }

});


// - - - - - - - - - - - - - - - - - - - - - -
//   Output stage, prepare results for return
//- - - - - - - - - - - - - - - - - - - - - -

/**
 * Own version of Array.prototype.map()
 *
 * @param {Array} source
 * @param  transform callback
 * @param {*=} context (*this* in called function)
 * @param {number=} max_out
 * @returns {Array}
 */

FuzzySearch.map = function (source, transform, context, max_out) {

    var n = source.length;
    if (max_out > 0 && max_out < n) n = max_out;
    if (typeof transform !== "function") return source.slice(0, n);

    var out = new Array(n);
    for (var i = -1; ++i < n;) {
        out[i] = transform.call(context, source[i], i, source);
    }

    return out;

};

/**
 * Take an array of objects, return an array containing a field of those object.
 *
 * test = [ {key:"A",value:10}, {key:"B",value:20}  ]
 * mapField(test,"value") = [10,20]
 *
 * @param source - array to process
 * @param {string} path - key to address on each item OR function to apply
 * @param {Number=} [max_out=source.length] - only process first items
 * @returns {Array}
 */

FuzzySearch.mapField = function (source, path, max_out) {

    var n = source.length;
    if (max_out > 0 && max_out < n) n = max_out;
    if (path === "") return source.slice(0, n);

    var out = new Array(n);
    var obj, i;


    if (path.indexOf(".") === -1) {
        //fast case no inner loop
        for (i = -1; ++i < n;) {
            obj = source[i];
            if (path in obj) out[i] = obj[path];
        }

    } else {

        //general case
        var parts = path.split(".");
        var nb_level = parts.length;

        for (i = -1; ++i < n;) {
            obj = source[i];

            for (var level = -1; ++level < nb_level;) {
                var key = parts[level];
                if (!(key in obj)) break;
                obj = obj[key];
            }

            out[i] = obj;
        }

    }

    return out;

};

/**
 * Filter array for item where item[field] >= atleast
 *
 * @param array
 * @param field
 * @param atleast
 * @returns {Array}
 */

FuzzySearch.filterGTE = function (array, field, atleast) {
    var i = -1, j = -1;
    var n = array.length;
    var out = [], obj;

    while (++i < n) {
        obj = array[i];
        if (obj[field] >= atleast) {
            out[++j] = obj;
        }
    }

    return out;
};


/**
 * SearchResult constructor
 * - Internal result list
 * - Output of search when output_map=""
 *
 * @param {*} item
 * @param {Array} fields
 * @param {number} item_score
 * @param {number} matched_field_index
 * @param {number} matched_field_sub
 * @param {(string|number)} sortkey
 * @constructor
 */

function SearchResult(item, fields, item_score, matched_field_index, matched_field_sub, sortkey) {
    this.item = item;
    this.fields = fields;
    this.score = item_score;
    this.matchIndex = matched_field_index;
    this.subIndex = matched_field_sub;
    this.sortKey = sortkey;
}


/**
 * Sort function
 * first by decreasing order of score, then alphabetical order of sortkey.
 *
 * @param {SearchResult} a
 * @param {SearchResult} b
 * @returns {number} -  ">0" if b before a, "<0" if b after a.
 */
function compareResults(a, b) {
    var d = b.score - a.score;
    if (d !== 0) return d;
    var ak = a.sortKey, bk = b.sortKey;
    return ak > bk ? 1 : ( ak < bk ? -1 : 0);
}

//
// - - - - - - - - - - - -
//  Prepare Query
// - - - - - - - - - - - -
//

extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {


    /**
     * Input: a user search string
     * Output a query object
     *
     * Perform a few transformation to allw faster searching.
     * String is set to lowercase, some accents removed, split into tokens.
     * Token too small are filtered out, token too large are trimmed.
     * Token are packed in group of 32 char, each token is processed to extract an alphabet map.
     *
     * If score_test_fused is enabled, we do an extra pass disregarding tokens.
     * IF score_per_token is disabled this is the only pass we do.
     *
     * @param query_string
     * @returns {Query}
     * @private
     */

    _prepQuery: function (query_string) {

        var options = this.options;
        var opt_tok = options.score_per_token;
        var opt_fuse = options.score_test_fused;
        var opt_fuselen = options.token_fused_max_length;
        var opt_qmin = options.token_field_min_length;
        var opt_qmax = options.token_field_max_length;

        var tags = this.tags;
        var tags_re = this.tags_re;
        var nb_tags = tags.length;

        var norm, fused, fused_map, children, has_tags, group;

        if (opt_tok && nb_tags && tags_re) {

            var start = 0, end;
            var q_index = 0;
            var q_parts = new Array(nb_tags + 1);

            var match = tags_re.exec(query_string);
            has_tags = (match != null);

            while (match != null) {
                end = match.index;
                q_parts[q_index] = query_string.substring(start, end);
                start = end + match[0].length;
                q_index = tags.indexOf(match[1]) + 1;
                match = tags_re.exec(query_string);
            }

            q_parts[q_index] = query_string.substring(start);

            children = new Array(nb_tags);

            for (var i = -1; ++i < nb_tags;) {

                var qp = q_parts[i + 1];
                if (!qp || !qp.length) continue;

                norm = options.normalize(qp);
                fused = norm.substring(0, opt_fuselen);
                fused_map = (opt_fuse || !opt_tok) ? FuzzySearch.alphabet(fused) : {};
                group = FuzzySearch.pack_tokens(FuzzySearch.filterSize(norm.split(" "), opt_qmin, opt_qmax));

                children[i] = new Query(norm, group, fused, fused_map, false, []);
            }


            norm = options.normalize(q_parts[0]);
            group = FuzzySearch.pack_tokens(FuzzySearch.filterSize(norm.split(" "), opt_qmin, opt_qmax));

        }

        else {
            norm = options.normalize(query_string);
            group = opt_tok ? FuzzySearch.pack_tokens(FuzzySearch.filterSize(norm.split(" "), options.token_query_min_length, options.token_query_max_length)) : [];
            has_tags = false;
            children = new Array(nb_tags);
        }

        fused = norm.substring(0, opt_fuselen);
        fused_map = (opt_fuse || !opt_tok) ? FuzzySearch.alphabet(fused) : {};

        return new Query(norm, group, fused, fused_map, has_tags, children)

    }
});

//
// Query objects
//

/**
 * Hold a query
 *
 * @param {string} normalized
 * @param {Array.<PackInfo>} tokens_groups
 * @param {string} fused_str
 * @param {Object} fused_map
 * @param {boolean} has_children
 * @param {Array<Query>} children
 *
 * @constructor
 */

function Query(normalized, tokens_groups, fused_str, fused_map, has_children, children) {

    this.normalized = normalized;
    this.tokens_groups = tokens_groups;

    this.fused_str = fused_str;
    this.fused_map = fused_map;
    this.fused_score = 0;

    this.has_children = has_children;
    this.children = children;

}

//
// Query hold some memory to keep score of it's tokens.
// Used in search methods

/**
 * Loop tru each item score and reset to 0, apply to child query
 */
Query.prototype.resetItem = function () {
    var groups = this.tokens_groups;

    for (var group_index = -1, nb_groups = groups.length; ++group_index < nb_groups;) {
        var score_item = groups[group_index].score_item;
        for (var i = -1, l = score_item.length; ++i < l;) score_item[i] = 0

    }

    this.fused_score = 0;

    if (this.has_children) {
        var children = this.children;
        for (var child_index = -1, nb_child = children.length; ++child_index < nb_child;) {
            var child = children[child_index];
            if (child) child.resetItem();
        }
    }

};

/**
 * Sum each item score and add to child score
 */
Query.prototype.scoreItem = function () {

    var query_score = 0;
    var groups = this.tokens_groups;

    for (var group_index = -1, nb_groups = groups.length; ++group_index < nb_groups;) {
        var group_scores = groups[group_index].score_item;
        for (var score_index = -1, nb_scores = group_scores.length; ++score_index < nb_scores;) {
            query_score += group_scores[score_index]
        }
    }

    if (this.fused_score > query_score) query_score = this.fused_score;

    if (this.has_children) {
        var children = this.children;
        for (var child_index = -1, nb_child = children.length; ++child_index < nb_child;) {
            var child = children[child_index];
            if (child) query_score += child.scoreItem();
        }
    }

    return query_score;

};


/**
 * Hold a group of token for parallel scoring
 *
 * @param {Array.<string>} group_tokens
 * @param {Object} group_map
 * @param {number} gate
 * @constructor
 */

function PackInfo(group_tokens, group_map, gate) {
    this.tokens = group_tokens;
    this.map = group_map;
    this.gate = gate;

    var t = group_tokens.length, i = -1;
    var scores = new Array(t);
    while (++i < t) scores[i] = 0;

    this.score_item = scores.slice();
    this.score_field = scores.slice();
    this.field_pos = scores;
}

//
// - - - - - - - - - - - - - - - - -
//     Prepare Token for search
// - - - - - - - - - - - - - - - - -
// a normal string can be view as an array of char.
// so we map ( position -> char).
//
// we reverse that relation to map
// char -> positions

/**
 * Record position of each character in a token.
 * If token is small, position is recorded by position of a single bit in an int.
 * If token is larger than INT_SIZE, position is recorder as array of number.
 *
 * @param {string} token
 * @returns {Object} key value map char->positions (as array of position or single int (can be seen as an array of bit) )
 */
FuzzySearch.alphabet = function (token) {
    var len = token.length;
    if (len > INT_SIZE) return FuzzySearch.posVector(token);
    else return FuzzySearch.bitVector(token, {}, 0);
};

/**
 * Apply FuzzySearch.alphabet on multiple tokens
 *
 * @param {Array.<string>} tokens
 * @returns {Array.<Object>}
 */
FuzzySearch.mapAlphabet = function (tokens) {
    var outlen = tokens.length;
    var out = new Array(outlen), i = -1;
    while (++i < outlen) {
        var t = tokens[i];
        if (t.length > INT_SIZE) out[i] = FuzzySearch.posVector(t);
        else out[i] = FuzzySearch.bitVector(t, {}, 0);
    }
    return out;
};

/**
 * Record position of each char using a single bit
 *
 * @param {string} token
 * @param {Object} map - Existing map to modify, can init with {}
 * @param offset - used for packing multiple word in a single map, can init with 0
 * @returns {Object} Key value map char -> int
 */

FuzzySearch.bitVector = function (token, map, offset) {

    var len = token.length;
    var i = -1, c;
    var b = offset;

    while (++i < len) {
        c = token[i];
        if (c in map) map[c] |= (1 << b++);
        else map[c] = (1 << b++);
    }

    return map;

};

/**
 * Record position of each char in a token using an array
 * Append Infinity as a stop marker for llcs_large
 *
 * map = posVector("position")
 * map["p"] -> [0,Inf]
 * map["o"] -> [1,6,Inf]
 *
 * @param {string} pattern
 * @returns {Object} - key value map char->array of position (as number)
 */
FuzzySearch.posVector = function (pattern) {

    var map = {}, c;

    var m = pattern.length, i = -1;
    while (++i < m) {
        c = pattern[i];
        if (c in map) map[c].push(i);
        else map[c] = [i];
    }

    for (c in map) {
        if (map.hasOwnProperty(c)) {
            map[c].push(Infinity);
        }
    }

    return map;

};

/**
 * Given a list of tokens, pack them into group of upto INT_SIZE(32) chars.
 * If a single token is bigger than INT_SIZE create a groupe of a single item
 * And use posVector instead of bitVector to prepare fallback algorithm.
 *
 * @param {Array.<string>} tokens
 * @returns {Array.<PackInfo>}
 */
FuzzySearch.pack_tokens = function (tokens) {

    var token_index = -1;
    var nb_tokens = tokens.length;
    var large;
    var groups = [];

    //For each group
    while (token_index < nb_tokens) {

        var group_tokens = [];
        var group_map = {};
        var offset = 0;
        var gate = 0;

        //For each token in the group
        while (++token_index < nb_tokens) {

            var token = tokens[token_index];
            var l = token.length;

            if (l >= INT_SIZE) {

                large = new PackInfo([token],
                    FuzzySearch.posVector(token),
                    0xFFFFFFFF);

                break;

            }
            else if (l + offset >= INT_SIZE) {
                token_index--;
                break;
            }
            else {
                group_tokens.push(token);
                FuzzySearch.bitVector(token, group_map, offset);
                gate |= ( (1 << ( token.length - 1) ) - 1 ) << offset;
                offset += l
            }

        }

        if (group_tokens.length > 0) {
            groups.push(new PackInfo(group_tokens, group_map, gate));
        }

        if (large) {
            groups.push(large);
            large = null;
        }

    }

    return groups;

};

//
//-----------------------------
//       SCORING FUNCTIONS
// ---------------------------
//

/**
 * Score of "search a in b" using self as options.
 * @param  {string} a
 * @param {string} b
 */
FuzzySearch.prototype.score = function (a, b) {
    var aMap = FuzzySearch.alphabet(a);
    return FuzzySearch.score_map(a, b, aMap, this.options);
};

// Adapted from paper:
// A fast and practical bit-vector algorithm for
// the Longest Common Subsequence problem
// Maxime Crochemore et Al.
//
// With modification from
// Bit-parallel LCS-length computation revisited (H Hyyrö, 2004)
// http://www.sis.uta.fi/~hh56766/pubs/awoca04.pdf
//

/**
 * Score of "search a in b" using precomputed alphabet map
 * Main algorithm for single query token to score
 *
 * @param {string} a
 * @param {string} b
 * @param {Object} aMap - See FuzzySearch.alphabet
 * @param {FuzzySearchOptions} options
 */
FuzzySearch.score_map = function (a, b, aMap, options) {

    var j, lcs_len;
    var m = a.length;
    var n = b.length;
    var bonus_prefix = options.bonus_match_start;

    var k = m < n ? m : n;
    if (k === 0 || n < options.token_min_rel_size * m || n > options.token_max_rel_size * m) return 0;

    //normalize score against length of both inputs
    var sz_score = (m + n) / ( 2.0 * m * n);

    //common prefix is part of lcs
    var prefix = 0;
    if (a === b) prefix = k; //speedup equality
    else {
        while ((a[prefix] === b[prefix]) && (++prefix < k)) {
        }
    }

    //shortest string consumed
    if (prefix === k) {
        lcs_len = prefix;
        return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;
    }

    //alternative algorithm for large string
    //need to keep this condition in sync with bitvector
    if (m > INT_SIZE) {
        lcs_len = FuzzySearch.llcs_large(a, b, aMap, prefix);
        return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;
    }

    var mask = ( 1 << m ) - 1;
    var S = mask, U, c;

    j = prefix - 1;
    while (++j < n) {
        c = b[j];
        if (c in aMap) {
            // Hyyrö, 2004 S=V'=~V
            U = S & aMap[c];
            S = (S + U) | (S - U);
        }
    }

    // Remove match already accounted in prefix region.
    mask &= ~( ( 1 << prefix ) - 1 );

    // lcs_len is number of 0 in S (at position lower than m)
    // inverse S, mask it, then do "popcount" operation on 32bit
    S = ~S & mask;

    S = S - ((S >> 1) & 0x55555555);
    S = (S & 0x33333333) + ((S >> 2) & 0x33333333);
    lcs_len = (((S + (S >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;

    lcs_len += prefix;
    return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;

};

/**
 * Score multiple query token against a single field token.
 * Apply above score function in parallel
 * Computation is done as if everything was one big token,
 * but ZM bit-vector modify boundary so score are independant
 *
 * @param {PackInfo} packinfo
 * @param {string} field_token
 * @param {FuzzySearchOptions} options
 * @returns {Array.<number>} scores
 */
FuzzySearch.score_pack = function (packinfo, field_token, options) {

    var packed_tokens = packinfo.tokens;
    var nb_packed = packed_tokens.length;

    var S = 0xFFFFFFFF, U, c;
    var ZM = packinfo.gate | 0;
    var aMap = packinfo.map;

    for (var j = -1, n = field_token.length; ++j < n;) {
        c = field_token[j];
        if (c in aMap) {
            U = S & aMap[c];
            S = ( (S & ZM) + (U & ZM) ) | (S - U);
        }
    }

    S = ~S;

    var bonus_prefix = options.bonus_match_start;
    var min_rs = options.token_min_rel_size;
    var max_rs = options.token_max_rel_size;
    var scores = new Array(nb_packed);
    var offset = 0;

    for (var k = -1; ++k < nb_packed;) {

        var query_tok = packed_tokens[k];
        var m = query_tok.length;
        var lcs_len, prefix;

        if (n < min_rs * m || n > max_rs * m) {
            scores[k] = 0;
            offset += m;
            continue;
        }

        if (query_tok === field_token)
            prefix = lcs_len = m;

        else {
            var p = (m < n) ? m : n;
            prefix = 0;
            while ((query_tok[prefix] === field_token[prefix]) && (++prefix < p)) {
            }
            lcs_len = prefix;
            var Sm = ( (S >>> offset) & ( (1 << m) - 1 ) ) >>> prefix;
            while (Sm) {
                Sm &= Sm - 1;
                lcs_len++
            }
        }

        offset += m;
        var sz = (m + n) / ( 2.0 * m * n);
        scores[k] = sz * lcs_len * lcs_len + bonus_prefix * prefix;

    }

    return scores;

};


//
// Compute LLCS, using vectors of position.
//
// Based on:
// An input sensitive online algorithm for LCS computation
// Heikki Hyyro 2009
//
// We fill the dynamic programing table line per line
// but instead of storing the whole line we only store position where the line increase
// ( bitvector algorithm store increase yes/no as a bit) this time we will store sequence
//
//    s u r g e r y
// g [0,0,0,1,1,1,1] : [3,4] (Add level 1)
// s [1,1,1,1,1,1,1] : [0,1] (Make level 1 happens sooner)
// u [1,2,2,2,2,2,2] : [0,2] (Add level 2, append to block of consecutive increase)
// r [1,2,3,3,3,3,3] : [0,3] (Add level 3, append to block of consecutive increase)
// v [1,2,3,3,3,3,3] : [0,3] (v not in surgery, copy)
// e [1,2,3,3,4,4,4] : [0,3],[4,5] (Add level 4, create new block for it)
// y [1,2,3,3,4,4,5] : [0,3],[4,5],[6,7] (Add level 5, create new block for it)
//
// There is 2 Basic operations:
// - Make a level-up happens sooner
// - Add an extra level up at the end. (this is where llcs increase !)
//
//  12345678901234567890  // Position (for this demo we start at 1)
//  ii------iii---i--i--  // Increase point of previous line
//  12222222345555666777  // Score previous line [1,3] [9,12] [15,16] [18,19]
//  ---m-m---------m---m  // Match of this line
//  12233333345555677778  // Score of this line [1,3] [4,5] [10,12] [15,17] [20,21]
//  ii-i-----ii---ii---i  // New increase point
//  12345678901234567890  // Position


FuzzySearch.llcs_large = function (a, b, aMap, prefix) {

    //var aMap = FuzzySearch.posVector(a);

    //Position of next interest point. Interest point are either
    // - Increase in previous line
    // - Match on this line
    var block_start, match_pos;

    // We encode increase sequence as [start_pos, end_pos+1]
    // So end-start = length

    // To avoid dealing with to many edge case we place
    // a special token at start & end of list
    var last_line, line_index, last_end, block_end;
    if (prefix === undefined) prefix = 0;

    if (prefix)
        last_line = [new Block(0, prefix), new Block(Infinity, Infinity)];
    else
        last_line = [new Block(Infinity, Infinity)];

    var lcs_len = prefix;

    var match_list, match_index;
    var block, block_index, block_size;

    //First line
    var nb_blocks = last_line.length;

    var n = b.length, j;
    for (j = prefix; j < n; j++) {

        //Each line we process a single character of b
        var c = b[j];
        if (!(c in aMap)) continue;
        match_list = aMap[c];

        //New line
        // the number of if block can only increase up to llcs+1+sentinel
        // alternatively each block having >1 item can split. (+1 at end accounted by splitting sentinel)
        /** @type Array.<Block> */
        var current_line = new Array(Math.min(2 * nb_blocks, lcs_len + 2));
        line_index = -1;

        //First match
        match_index = 0;
        match_pos = match_list[0];

        //Place end of first block before the string
        block_end = -1;
        block_index = -1;


        while (++block_index < nb_blocks) {

            //Place cursor just after last block
            last_end = block_end;

            //Read end block
            block = last_line[block_index];
            block_start = block.start; //Encode block as [s,e[
            block_end = block.end; //End is position of char that follow last.
            block_size = block_end - block_start; //Size of block,  for sentinel (Inf-Inf=NaN)

            //get next match from list of matches
            while (match_pos < last_end) {
                match_pos = match_list[++match_index];
            }

            // This cover two case
            // a) no match between two block
            // b) block happens after last match (so match_pos=Infinity).
            //    At the last block, this will append closing "sentinel" to line
            if (block_start <= match_pos) {
                current_line[++line_index] = block;
                continue;
            }

            //
            // If we have reached here, we have a dominant match !
            // Decide where to register the match ...
            //

            if (match_pos === last_end) {
                //End of last block ? (step a.ii)
                current_line[line_index].end++;
            }
            else {

                //Increase need it's own block ( step a.i)
                //try to reuse block that will get deleted.
                if (block_size === 1) {
                    //Can we reuse next block ?
                    block.start = match_pos;
                    block.end = match_pos + 1;
                    current_line[++line_index] = block;
                } else {
                    //start a new block
                    current_line[++line_index] = new Block(match_pos, match_pos + 1);
                }

            }

            // if not empty, append next block to current line (step a.iii)
            // (this condition reject "sentinel", it'll get added just after the for loop)
            if (block_size > 1) {
                block.start++; // Move start by one
                current_line[++line_index] = block;
            }

        }

        // If the line finish with a match:
        //  a) llcs at end of this line is one greater than last line, increase score
        //  b) we still need to append sentinel
        if (block_start > match_pos) {
            current_line[++line_index] = block;
            lcs_len++
        }


        //Current become last
        last_line = current_line;

        //Count actual number of block because we allocate a bit more.
        nb_blocks = ++line_index;


    }

    return lcs_len;

};

/**
 * A block with start and end position
 * Used to record consecutive increase position in llcs_large
 * @param start
 * @param end
 * @constructor
 */
function Block(start, end) {
    this.start = start;
    this.end = end;
}

//
// Reference implementation to debug
// Might need to swap input to match internal of a given algorithm
//

/*
 function lcs(a, b) {

 var m = a.length;
 var n = b.length;
 var i, j;

 //init m by n array  with 0
 var C = [], row = [], lcs = [];
 for (j = 0; j < n; j++) row[j] = 0;
 for (i = 0; i < m; i++) C[i] = row.slice();

 //fill first row and col
 C[0][0] = (a[0] === b[0]) ? 1 : 0;
 for (i = 1; i < m; i++) C[i][0] = (a[i] === b[0] || C[i - 1][0]) ? 1 : 0
 for (j = 1; j < n; j++) C[0][j] = (a[0] === b[j] || C[0][j - 1]) ? 1 : 0
 console.log(JSON.stringify(C[0]));

 //bulk
 for (i = 1; i < m; i++) {
 for (j = 1; j < n; j++) {
 C[i][j] = (a[i] === b[j]) ? C[i - 1][j - 1] + 1 : Math.max(C[i][j - 1], C[i - 1][j]);
 }
 console.log(JSON.stringify(C[i]));
 }

 //backtrack
 i--;
 j--;
 while (i > -1 && j > -1) {
 if (i && C[i][j] == C[i - 1][j])  i--;
 else if (j && C[i][j] == C[i][j - 1]) j--;
 else {
 lcs.push(a[i]);
 j--;
 i--;
 }
 }

 return lcs.reverse().join('');
 }*/
// main entry of the algorithm (once settings are set)
// loop over everything and merge best scores

extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {

    /**
     * Perform a search on the already indexed source.
     *
     * @param {string} query_string
     * @returns {Array}
     */
    search: function (query_string) {

        var clock = (window.performance && window.performance.now) ? window.performance : Date;
        var time_start = clock.now();
        this.start_time = time_start;
        var options = this.options;

        if (this.dirty) {
            this._prepSource(this.source, this.keys, true);
            this.dirty = false;
        }

        var query = this.query = this._prepQuery(query_string);
        var source = this.index;
        var results = [];

        if (options.filter) {
            source = options.filter.call(this, source);
        }

        // ---- MAIN SEARCH LOOP ---- //
        var thresh_include = this._searchIndex(query, source, results);

        //keep only results that are good enough compared to best
        results = FuzzySearch.filterGTE(results, "score", thresh_include);

        // sort by decreasing order of score
        // equal rounded score: alphabetical order
        if (typeof options.sorter === "function")
            results = results.sort(options.sorter);

        if (options.output_map || options.output_limit > 0) {
            if (typeof options.output_map === "function")
                results = FuzzySearch.map(results, options.output_map, this, options.output_limit);
            else
                results = FuzzySearch.mapField(results, options.output_map, options.output_limit);
        }

        var time_end = clock.now();
        this.search_time = time_end - time_start;
        this.results = results;

        return results

    },


    /**
     * Main search loop for a specified source
     * This separation allow to search a different source, or a subset of source
     *
     * @param {Query} query
     * @param {Array.<Indexed>} source
     * @param {Array.<SearchResult>} results
     * @returns {number} - thresh_include after this run.
     *
     * @private
     */

    _searchIndex: function (query, source, results) {

        var options = this.options;
        var opt_bpd = options.bonus_position_decay;
        var opt_fge = options.field_good_enough;
        var opt_trb = options.thresh_relative_to_best;
        var opt_score_tok = options.score_per_token;
        var opt_round = options.score_round;
        var thresh_include = options.thresh_include;

        var best_item_score = 0;

        var sub_query = query.children;

        for (var item_index = -1, nb_items = source.length; ++item_index < nb_items;) {

            //get indexed fields
            var item = source[item_index];
            var item_fields = item.fields;

            //reset score
            query.resetItem();

            var item_score = 0;
            var matched_field_index = -1;
            var matched_node_index = -1;
            var position_bonus = 1.0;

            //
            //Foreach field
            //

            for (var field_index = -1, nb_fields = item_fields.length; ++field_index < nb_fields;) {

                var field_score = 0;
                var field_node = -1;
                var field = item_fields[field_index];

                var child_query = sub_query[field_index]; //tag search
                var tagged = !!child_query;

                for (var node_index = -1, nb_nodes = field.length; ++node_index < nb_nodes;) {
                    var node_score, node = field[node_index];

                    if (opt_score_tok) {
                        node_score = this._scoreField(node, query);
                        if (tagged) node_score += this._scoreField(node, child_query);//tag search
                    }
                    else
                        node_score = FuzzySearch.score_map(query.fused_str, node.join(" "), query.fused_map, options);

                    if (node_score > field_score) {
                        field_score = node_score;
                        field_node = node_index;
                    }
                }

                field_score *= (1.0 + position_bonus);
                position_bonus *= opt_bpd;

                if (field_score > item_score) {
                    item_score = field_score;
                    matched_field_index = field_index;
                    matched_node_index = field_node;

                    if (field_score > opt_fge) break;
                }

            }

            //
            // Different query token match different fields ?
            //

            if (opt_score_tok) {

                var query_score = query.scoreItem();
                item_score = 0.5 * item_score + 0.5 * query_score;

            }

            //
            // Keep track of best result, this control inclusion in the list
            //

            if (item_score > best_item_score) {
                best_item_score = item_score;
                var tmp = item_score * opt_trb;
                if (tmp > thresh_include) thresh_include = tmp;
            }

            //
            //candidate for best result ? push to list
            //

            if (item_score > thresh_include) {

                item_score = Math.round(item_score / opt_round) * opt_round;

                results.push(new SearchResult(
                    item.item,
                    item_fields,
                    item_score,
                    matched_field_index,
                    matched_node_index,
                    item_fields[0][0].join(" ")
                ));

            }

        }

        return thresh_include
    },

    /**
     * Internal loop that is run for each field in an item
     *
     * @param {Array} field_tokens
     * @param {Query} query
     * @returns {number}
     * @private
     */

    _scoreField: function (field_tokens, query) {

        var groups = query.tokens_groups;
        var nb_groups = groups.length;
        if (!nb_groups) return 0;

        var nb_tokens = field_tokens.length;
        var field_score = 0, sc;
        var last_index = -1;
        var options = this.options;

        var bonus_order = options.bonus_token_order;
        var minimum_match = options.minimum_match;

        var token, scores, i;
        for (var group_index = -1; ++group_index < nb_groups;) {

            var group_info = groups[group_index];
            var group_tokens = group_info.tokens;
            var nb_scores = group_tokens.length;
            var single = (nb_scores == 1);

            //each packinfo/group have their own reusable scratch pad
            // to store best score information, how neat :)
            var best_of_field = group_info.score_field;
            for (i = -1; ++i < nb_scores;) best_of_field[i] = 0

            var best_index = group_info.field_pos;
            for (i = -1; ++i < nb_scores;) best_index[i] = 0

            for (var field_tk_index = -1; ++field_tk_index < nb_tokens;) {

                token = field_tokens[field_tk_index];

                if (single) {

                    sc = FuzzySearch.score_map(group_tokens[0], token, group_info.map, options);
                    if (sc > best_of_field[0]) {
                        best_of_field[0] = sc;
                        best_index[0] = field_tk_index;
                    }

                }
                else {

                    scores = FuzzySearch.score_pack(group_info, token, options);
                    for (i = -1; ++i < nb_scores;) {
                        sc = scores[i];
                        if (sc > best_of_field[i]) {
                            best_of_field[i] = sc;
                            best_index[i] = field_tk_index;
                        }
                    }

                }

            }

            var best_match_this_item = group_info.score_item;
            for (i = -1; ++i < nb_scores;) {

                sc = best_of_field[i];
                field_score += sc;

                // if search token are ordered inside subject give a bonus
                // only consider non empty match for bonus
                if (sc > minimum_match) {
                    var tmp = best_index[i];
                    if (tmp > last_index) {
                        field_score += bonus_order;
                        sc += bonus_order
                    }
                    last_index = tmp;
                }

                if (sc > best_match_this_item[i])
                    best_match_this_item[i] = sc;

            }


        }

        if (options.score_test_fused) {
            // test "space bar is broken" no token match
            var fused_score = FuzzySearch.score_map(query.fused_str, field_tokens.join(" "), query.fused_map, options);
            field_score = fused_score > field_score ? fused_score : field_score;

            if (fused_score > query.fused_score) {
                query.fused_score = fused_score;
            }
        }


        return field_score;

    }
});



extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {

    //
    // - - - - - - - - - - - -
    // PROCESS INPUT DATA
    // - - - - - - - - - - - -
    //

    /**
     * Add or replace data to search in.
     * Flatten object into array using specified keys,
     * Apply lowercase, accent removal
     * Split field into token
     * Remove small token eg "a" "of" and prefix large token
     *
     * @param {Array.<Object>} source
     * @param {Array.<string>} keys
     * @param {boolean} overwrite
     * @private
     *
     */

    _prepSource: function (source, keys, overwrite) {

        var nb_items = source.length, out_index;

        if (overwrite) {
            this.index = new Array(nb_items);
            out_index = 0
        } else
            out_index = nb_items;

        var index = this.index;
        var options = this.options;
        var min_size = options.token_field_min_length;
        var max_size = options.token_field_max_length;
        var acronym = options.score_acronym;
        var acronym_re = this.acro_re;

        for (var item_index = -1; ++item_index < nb_items;) {

            var item = source[item_index];
            var item_fields = FuzzySearch.generateFields(item, keys);

            var nb_fields = item_fields.length;

            for (var field_index = -1; ++field_index < nb_fields;) {

                var field = item_fields[field_index];
                for (var node_index = -1, nb_nodes = field.length; ++node_index < nb_nodes;) {

                    var norm = options.normalize(field[node_index]);
                    var nodes = FuzzySearch.filterSize(norm.split(" "), min_size, max_size);
                    if (acronym) nodes.push(norm.replace(acronym_re, "$1"));
                    field[node_index] = nodes;

                }

            }

            index[out_index++] = new Indexed(item, item_fields);

        }

    }
});

/**
 * Original item with cached normalized field
 *
 * @param {*} original
 * @param {Array.<string>} fields
 * @constructor
 */

function Indexed(original, fields) {
    this.item = original;
    this.fields = fields;
}

// - - - - - - - - - - - - - - - - - - - - - -
//   Input stage: prepare field for search
//- - - - - - - - - - - - - - - - - - - - - -

/**
 * Take a string into a normal form. Allow to compare in a case insensitive way.
 * Also allow to match accents with their base form "é" vs "e"
 * Finally standardize token separator to be a single space.
 *
 * @param {string} str
 * @returns {string} - normalized str
 */
function normalize(str) {
    if (!str)return "";
    return str.toLowerCase().replace(/\s+/g, " ").replace(/[^\u0000-\u007E]/g, function (a) {
        return diacriticsMap[a] || a;
    });
}

function getDiacriticsMap() {
    // replace most common accents in french-spanish by their base letter
    //"ãàáäâæẽèéëêìíïîõòóöôœùúüûñç"
    var from = "\xE3\xE0\xE1\xE4\xE2\xE6\u1EBD\xE8\xE9\xEB\xEA\xEC\xED\xEF\xEE\xF5\xF2\xF3\xF6\xF4\u0153\xF9\xFA\xFC\xFB\xF1\xE7";
    var to = "aaaaaaeeeeeiiiioooooouuuunc";
    var diacriticsMap = {};
    for (var i = 0; i < from.length; i++) {
        diacriticsMap[from[i]] = to[i]
    }
    return diacriticsMap;
}

var diacriticsMap = getDiacriticsMap();


/**
 * Given an object to index and a list of field to index
 * Return a flat list of the values.
 *
 * @param {Object} obj
 * @param {Array.<string>} fieldlist
 * @returns {Array}
 */

FuzzySearch.generateFields = function (obj, fieldlist) {

    if (!fieldlist.length) return [[obj.toString()]];

    var n = fieldlist.length;
    var indexed_fields = new Array(n);

    for (var i = -1; ++i < n;)
        indexed_fields[i] = _collectValues(obj, fieldlist[i].split("."), [], 0);

    return indexed_fields;

};


/**
 * Traverse an object structure to collect item specified by parts.
 * If leaf node is an array or dictionary collect every children.
 * If key is wildcard '*' branch out the search process on each children.
 *
 * @param {*} obj - root to process
 * @param {Array.<string>} parts - array of subkey to direct object traversal  "those.that.this"->["those","that","this"]
 * @param {Array} list - where to put collected items
 * @param {number} level - index of current position on parts list
 * @returns {Array} - return list
 * @private
 */
function _collectValues(obj, parts, list, level) {

    var key, i, olen;
    var nb_level = parts.length;
    while (level < nb_level) {

        key = parts[level++];
        if (key === "*" || key === "") break;
        if (!(key in obj)) return list;
        obj = obj[key];

    }

    var type = Object.prototype.toString.call(obj);
    var isArray = ( type === '[object Array]'  );
    var isObject = ( type === '[object Object]' );

    if (level === nb_level) {

        if (isArray)
            for (i = -1, olen = obj.length; ++i < olen;) list.push(obj[i].toString());

        else if (isObject) {
            for (key in obj) {
                if (obj.hasOwnProperty(key)) list.push(obj[key].toString());
            }
        }

        else list.push(obj.toString());


    }

    else if (key === "*") {

        if (isArray)
            for (i = -1, olen = obj.length; ++i < olen;) {
                _collectValues(obj[i], parts, list, level);
            }

        else if (isObject)
            for (key in obj) {
                if (obj.hasOwnProperty(key))
                    _collectValues(obj[key], parts, list, level);
            }
    }

    return list;
}

/**
 * Process an array of string, filter out item smaller than min, trim item larger than max.
 *
 * @param {Array.<string>} array - array of string
 * @param minSize - filter out item smaller than this
 * @param maxSize - substring item larger than this
 * @returns {Array}
 */

FuzzySearch.filterSize = function (array, minSize, maxSize) {
    var i = -1, j = -1;
    var n = array.length;
    var out = [];
    var str, slen;

    while (++i < n) {
        str = array[i];
        slen = str.length;
        if (slen >= minSize) out[++j] = (slen < maxSize) ? str : str.substr(0, maxSize)
    }
    return out;
};
/** @lends {FuzzySearchOptions.prototype} */
var highlightOptions = {

    highlight_prefix: false,         // true: force prefix as part of highlight, (false: minimum gap, slower)
    highlight_bridge_gap: 2,         // display small gap as substitution, set to size of gap, 0 to disable
    highlight_before: '<strong class="highlight">',  //tag to put before/after the highlight
    highlight_after: '</strong>'

};

//
// Extend base option to support highlight
//
var defaults = FuzzySearch.defaultOptions;

for (var key in highlightOptions) {
    if (highlightOptions.hasOwnProperty(key)) {
        defaults[key] = highlightOptions[key];
    }
}

/**
 * Highlight a string using query stored in a FuzzySearch object.
 * @param {string} str
 * @param {string=} field
 */
FuzzySearch.prototype.highlight = function (str, field) {
    var i, subq;
    var qnorm = this.query.normalized;
    if (field && field.length && (i = this.tags.indexOf(field)) > -1 && (subq = this.query.children[i])) qnorm += (qnorm.length ? " " : "") + subq.normalized;
    return FuzzySearch.highlight(qnorm, str, this.options)
};

/**
 * Highlight string b, from searching a in it.
 *
 * @param {string} a - string to search
 * @param {string} b - string to highlight
 * @param {FuzzySearchOptions=} options
 *
 */
FuzzySearch.highlight = function (a, b, options) {

    if (options === undefined) options = FuzzySearch.defaultOptions;
    if (!b) return "";

    var open_string = options.highlight_before;
    var close_string = options.highlight_after;
    var opt_score_tok = options.score_per_token;
    var opt_fuse = options.score_test_fused;
    var opt_acro = options.score_acronym;

    var aa = options.normalize(a).trim();
    var bb = options.normalize(b).trim();

    var a_tokens = aa.split(" ");
    var b_tokens = bb.split(" ");
    var disp_tokens = b.split(/\s+/);

    var strArr = [];
    var match_list = [];
    var fused_score = 0, match_score = 0;

    if (opt_score_tok) {
        match_score = FuzzySearch.matchTokens(a_tokens, b_tokens, match_list, options, true);
    }

    //Test "space bar is broken" no token match
    if (opt_fuse || !opt_score_tok || opt_acro) fused_score = FuzzySearch.score_map(aa, bb, FuzzySearch.alphabet(aa), options);

    if (match_score === 0 && fused_score === 0) return b; //shortcut no match


    if (!opt_score_tok || fused_score > match_score) {
        a_tokens = [aa]; //everything in a single token
        b_tokens = [bb];
        disp_tokens = [disp_tokens.join(" ")];
        match_list = [0];
    }

    var nbtok = disp_tokens.length, j = -1;
    while (++j < nbtok) {

        var i = match_list[j];

        if (i === -1) {
            strArr.push(disp_tokens[j] + " ");
            continue;
        }

        var ta = a_tokens[i];
        var tb = b_tokens[j];
        var td = disp_tokens[j];
        var curr = 0;

        var start_positions = [];
        var end_positions = [];
        FuzzySearch.align(ta, tb, start_positions, end_positions);
        var len = start_positions.length;

        var k = -1;
        while (++k < len) {

            var s = start_positions[k];
            var e = end_positions[k];
            if (s > curr) strArr.push(td.substring(curr, s));
            strArr.push(open_string + td.substring(s, e) + close_string);
            curr = e;

        }

        strArr.push(td.substring(curr) + " ");

    }

    return strArr.join('');

};


//
// Smith-Waterman-Gotoh local Alignment
//
// Smith&Waterman worked the idea of local alignment
// While Gotoh 82  worked on affine gap penalty.
//
// This is the basic algorithm with some optimisation to use less space.
// JAligner has been used as a reference implementation to debug.
// Some of their implementation detail to save memory has been reused here.
//
// See pseudo-code on
// http://jaligner.sourceforge.net/api/jaligner/SmithWatermanGotoh.html
//
//

/**
 * Smith-Waterman-Gotoh local Alignment
 * Build sequences of matches, called send array (seq_start,seq_end) to store them
 * Return match score
 *
 * @param {string} a -  string to search
 * @param {string} b - string to be searched
 * @param {Array.<number>} seq_start - store for match start
 * @param {Array.<number>} seq_end - store for match end
 * @param {FuzzySearchOptions=} options
 * @returns {number}
 */

FuzzySearch.align = function (a, b, seq_start, seq_end, options) {

    if (options === undefined) options = FuzzySearch.defaultOptions;

    var wm = 100; // score of making a match
    var wo = -10; // score to open a gap
    var we = -1;  // score to continue an open gap

    //Traceback directions constants
    var STOP = 0;
    var UP = 1;
    var LEFT = 2;
    var DIAGONAL = 3;

    var score_acronym = options.score_acronym;
    var sep_tokens = options.acronym_tok;

    var m = Math.min(a.length + 1, options.token_query_max_length);
    var n = Math.min(b.length + 1, options.token_field_max_length);

    // Comon prefix is part of lcs,
    // but not necessarily part of best alignment  (it can introduce an extra gap)
    // however prefix  make sens in an autocomplete scenario and speed things up
    //
    var i, j;
    var k = m < n ? m : n;
    var prefix_len = 0;

    if (a === b) {
        //speedup equality
        prefix_len = m;
        m = 0;
    }
    else if (options.highlight_prefix) {
        for (i = 0; i < k && (a[i] === b[i]); i++) prefix_len++;

        if (prefix_len) {
            a = a.substring(prefix_len);
            b = b.substring(prefix_len);

            m -= prefix_len;
            n -= prefix_len;
        }
    }

    var vmax = 0, imax = 0, jmax = 0;
    var trace = new Array(m * n);
    var pos = n - 1;

    //m,n = length+1
    if (m > 1 && n > 1) {


        var vrow = new Array(n), vd, v, align;
        var gapArow = new Array(n), gapA, gapB = 0;

        for (j = 0; j < n; j++) {
            gapArow[j] = 0;
            vrow[j] = 0;
            trace[j] = STOP;
        }

        for (i = 1; i < m; i++) {

            gapB = 0;
            vd = vrow[0];

            pos++;
            trace[pos] = STOP;

            for (j = 1; j < n; j++) {

                //
                // Reference "pseudocode"
                // We try to fill that table, but using o(n) instead o(m*n) memory
                // If we need traceback we still need o(m*n) but we store a single table instead of 3
                //
                // F[i][j] = f =  Math.max(F[i - 1][j] + we, V[i - 1][j] + wo );
                // E[i][j] = e = Math.max(E[i][j - 1] + we, V[i][j - 1] + wo );
                // align = (a[i - 1] === b[j - 1]) ? V[i - 1][j - 1] + wm : -Infinity;
                // V[i][j] = v = Math.max(e, f, align, 0);
                //

                // Score the options
                gapA = gapArow[j] = Math.max(gapArow[j] + we, vrow[j] + wo); //f
                gapB = Math.max(gapB + we, vrow[j - 1] + wo); //e

                if (score_acronym)
                    align = ( a[i - 1] !== b[j - 1] ) ? -Infinity : (
                        vd + wm +
                        ( ( i < 2 || sep_tokens.indexOf(a[i - 2]) > -1 ) ? wm : 0) +
                        ( ( j < 2 || sep_tokens.indexOf(b[j - 2]) > -1 ) ? wm : 0)
                    );
                else
                    align = ( a[i - 1] === b[j - 1] ) ? vd + wm : -Infinity;

                vd = vrow[j];

                v = vrow[j] = Math.max(align, gapA, gapB, 0);

                // Determine the trace back direction
                pos++;  //pos = i * n + j;
                switch (v) {

                    // what triggered the best score ?

                    case align:
                        trace[pos] = DIAGONAL;

                        if (v > vmax) {
                            vmax = v;
                            imax = i;
                            jmax = j;
                        }

                        break;

                    case gapB:
                        trace[pos] = LEFT;
                        break;

                    case gapA:
                        trace[pos] = UP;
                        break;

                    default:
                        trace[pos] = STOP;
                        break;

                }


            }
        }


    }

    // - - - - - - - - -
    //     TRACEBACK
    // - - - - - - - - -

    var bridge = options.highlight_bridge_gap;
    var last_match = 0;

    if (vmax > 0) {

        // backtrack to aligned sequence
        // record start and end of substrings
        // vmax happens at the end of last substring

        i = imax;
        j = jmax;
        pos = i * n + j;
        last_match = jmax;
        seq_end.push(jmax + prefix_len);


        var backtrack = true;
        while (backtrack) {

            switch (trace[pos]) {

                case UP:
                    i--;
                    pos -= n;
                    break;

                case LEFT:
                    j--;
                    pos--;
                    break;

                case DIAGONAL:

                    // if we have traversed a gap
                    // record start/end of sequence
                    // (unless we want to bridge the gap)

                    if (last_match - j > bridge) {
                        seq_start.push(last_match + prefix_len);
                        seq_end.push(j + prefix_len);
                    }

                    j--;
                    i--;
                    last_match = j;
                    pos -= n + 1;
                    break;

                case STOP:
                default :
                    backtrack = false;

            }

        }

        //first matched char
        seq_start.push(last_match + prefix_len);

    }


    if (prefix_len) {

        if (last_match > 0 && last_match <= bridge) {

            //bridge last match to prefix ?
            seq_start[seq_start.length - 1] = 0

        } else {

            //add prefix to matches
            seq_start.push(0);
            seq_end.push(prefix_len);

        }

    }

    //array were build backward, reverse to sort
    seq_start.reverse();
    seq_end.reverse();

    return vmax + prefix_len;


};


//
// Each query token is matched against a field token
// or against nothing (not in field)
//
// a: [paint] [my] [wall]
// b: [wall] [painting]
//
// match: [1, -1, 0]
//
// if a[i] match b[j]
//      then match[i] = j
//
// if a[i] match nothing
//      then match[i] = -1
//
// return match score
// take vector match by reference to output match detail
//
// Ideal case:
// each token of "a" is matched against it's highest score(a[i],b[j])
//
// But in case two token have the same best match
// We have to check for another pairing, giving highest score
// under constraint of 1:1 exclusive match
//
// To do that we check all possible pairing permutation,
// but we restrict ourselves to a set of plausible pairing.
//
// That is a token a will only consider pairing with a score at least
//     thresh_relative_to_best * [highest score]
//

/**
 * Match token of A again token of B, under constraint that tokens can be matched at most once.
 *
 * @param {Array.<string>} a_tokens
 * @param {Array.<string>} b_tokens
 * @param {Array.<number>} match - array to store results
 * @param {FuzzySearchOptions=} options
 * @param {boolean=} flip - if true score A against B, but return index of B against A.
 * @returns {number} Score of the best match combination.
 */
FuzzySearch.matchTokens = function (a_tokens, b_tokens, match, options, flip) {

    if (options === undefined) options = FuzzySearch.defaultOptions;
    if (flip == undefined) flip = false;

    var minimum_match = options.minimum_match;
    var best_thresh = options.thresh_relative_to_best;

    var i, j, row;
    var C = [];

    var m = a_tokens.length;
    var n = b_tokens.length;

    var a_maps = FuzzySearch.mapAlphabet(a_tokens);
    var a_tok, b_tok, a_mp;

    var rowmax = minimum_match, imax = -1, jmax = -1, v;
    var match_count = 0;
    var thresholds = [];

    for (i = 0; i < m; i++) {

        row = [];
        match[i] = -1;
        rowmax = minimum_match;

        a_tok = a_tokens[i];
        if (!a_tok.length) {
            //skip score loop but still fill array
            for (j = 0; j < n; j++) row[j] = 0;
            continue;
        }

        a_mp = a_maps[i];

        for (j = 0; j < n; j++) {

            b_tok = b_tokens[j];
            if (!b_tok.length) {
                row[j] = 0;
                continue;
            }

            v = FuzzySearch.score_map(a_tok, b_tok, a_mp, options);
            row[j] = v;

            if (v > minimum_match) match_count++;

            if (v > rowmax) {
                rowmax = v;
                imax = i;
                jmax = j;
            }

        }

        thresholds[i] = rowmax;

        C[i] = row;
    }

    //Shortcut: no match
    if (match_count === 0) return 0;

    //Shortcut: single possible pairing
    if (match_count === 1) {
        match[imax] = jmax;
        if (flip) _flipmatch(match, n);
        return rowmax
    }


    //Only consider matching close enough to best match
    for (i = 0; i < a_tokens.length; i++) {
        thresholds[i] = Math.max(best_thresh * thresholds[i], minimum_match);
    }


    var score = _matchScoreGrid(C, match, thresholds);

    //Flip back the problem if necessary
    if (flip) _flipmatch(match, n);

    return score;

};

/**
 * Perform the match as FuzzySearch.matchTokens
 * but token against token score is already computed as C
 *
 * This is mostly a preparation phase for _buildScoreTree as well
 * as a post processing traversal to recover the match.
 *
 * @param {Array.<Array.<number>>} C - precomputed score
 * @param {Array.<number>} match - store the position of best matches
 * @param {Array.<number>} thresholds - Information about the minimum score each token is willing to match
 * @returns {number} - best score
 * @private
 */
function _matchScoreGrid(C, match, thresholds) {

    var i_len = C.length;
    var i, j;

    //Traverse score grid to find best permutation
    var score_tree = [];
    for (i = 0; i < i_len; i++) {
        score_tree[i] = {};
    }

    var score = _buildScoreTree(C, score_tree, 0, 0, thresholds);

    var used = 0, item;

    for (i = 0; i < i_len; i++) {

        item = score_tree[i][used];
        if (!item) break;
        match[i] = j = item.index;
        if (j > -1) used |= (1 << j);

    }

    return score
}

//
// Cache tree:
//
// Given 5 node: 1,2,3,4,5
//
//  What is the best match ...
//    - knowing that we have passed tru 1->2->3
//    - knowing that we have passed tru 2->3->1
//    - knowing that we have passed tru 3->1->2
//
//  All those question have the same answer
//  because they are equivalent to match {4,5} against {4,5}
// ( in an alternate pass we can match {1,3} against {4,5} for example )
//
// We store match in j in a bit vector of size 32
//
// In addition of saving computation, the cache_tree data structure is used to
// trace back the best permutation !
//
// In addition of quick testing if an item is already used, used_mask serve
// as a key in cache_tree (in addition to level). Ideal key would be a list of available trial
// but, used & available are complementary vector (~not operation) so used is a perfectly valid key too...


/**
 * Branch out to try each permutation of items of A against item of B.
 * - Only try branched not already used.
 * - Prune branch below token threshold.
 * - Build a tree to cache sub-problem for which we already have a solution
 *
 * @param {Array.< Array.<number> >} C
 * @param {Array< Object.<number, MatchTryout> >} cache_tree
 * @param {number} used_mask
 * @param {number} depth
 * @param {Array.<number>} score_thresholds
 * @returns {number} score
 * @private
 */
function _buildScoreTree(C, cache_tree, used_mask, depth, score_thresholds) {

    var ilen = C.length;
    var jlen = C[depth].length;
    if (jlen > INT_SIZE) jlen = INT_SIZE;

    var j, score;
    var include_thresh = score_thresholds[depth];
    var best_score = 0, best_index = -1;
    var has_child = (depth < ilen - 1);
    var child_tree = cache_tree[depth + 1], child_key;

    for (j = 0; j < jlen; j++) {

        var bit = 1 << j;

        //if token previously used, skip
        if (used_mask & bit) continue;

        //score for this match
        score = C[depth][j];

        //too small of a match, skip
        if (score < include_thresh) continue;

        //score for child match
        //if we already have computed this sub-block get from cache
        if (has_child) {
            child_key = used_mask | bit;
            if (child_key in  child_tree) score += child_tree[child_key].score;
            else score += _buildScoreTree(C, cache_tree, child_key, depth + 1, score_thresholds);
        }

        if (score > best_score) {
            best_score = score;
            best_index = j;
        }

    }

    //try the move of "do not match this token against anything"
    if (has_child) {

        child_key = used_mask;
        if (child_key in  child_tree) score = child_tree[child_key].score;
        else  score = _buildScoreTree(C, cache_tree, child_key, depth + 1, score_thresholds);

        if (score > best_score) {
            best_score = score;
            best_index = -1;
        }

    }

    cache_tree[depth][used_mask] = new MatchTryout(best_score, best_index);
    return best_score;

}

/**
 *
 * @param score
 * @param index
 * @constructor
 */
function MatchTryout(score, index) {
    this.score = score;
    this.index = index;
}

/**
 * Let A,B be two array
 * Input is an array that map "index of A"->"index of B"
 * Output is the reverse "index of B"->"index of A"
 *
 * Array is modified in place
 *
 * @param {Array.<number>} match - array to remap
 * @param {number} newlen - length of B
 * @private
 */

function _flipmatch(match, newlen) {

    var i, j;
    var ref = match.slice();
    match.length = newlen;

    for (i = 0; i < newlen; i++) {
        match[i] = -1;
    }

    for (i = 0; i < ref.length; i++) {
        j = ref[i];
        if (j > -1 && j < newlen) match[j] = i;
    }

}
//
// - - - - - - - - - - - -
//  UI INTEGRATION
// - - - - - - - - - - - -
//

extend(FuzzySearch.prototype, /** @lends {FuzzySearch.prototype} */ {

    /**
     * Return a Debounced version of FuzzySearch.search.
     * New function signature allow to specific callback for different phase of the debounce.
     * De-bounce is adaptative, it will allow short burst and try to learn actual computation time.
     *
     * query: term to search
     * immediate_cb(results) : if search was done without filtering
     * suppress_cb(cached_results) : debounce has supressed the search, return cache of last result
     * finally_cb(results): if at least 1 supression occured, make a new search when debounce end and call this.
     *
     * @returns {function({string}, function({Array}), function({Array}), function({Array}))}
     */
    getInteractive: function () {

        var self = this;
        var options = this.options;
        var wait = options.interactive_debounce;
        var mult = options.interactive_mult;
        var burst = options.interactive_burst;

        // Debounce off
        if (wait === 0) {
            return (function (query, immediate_cb, suppress_cb, finally_cb) {
                return immediate_cb(self.search(query))
            })
        }

        // Debounce
        var clock = (window.performance && window.performance.now) ? window.performance : Date;
        var timeout, cache;
        var count = 0, suppressed = false;

        return function (query, immediate_cb, suppress_cb, finally_cb) {

            var later = function () {
                timeout = null;
                if (suppressed) {
                    cache = self.search(query);
                    finally_cb(cache);
                }
                count = 0;
                suppressed = false;
            };

            clearTimeout(timeout);
            timeout = setTimeout(later, wait);

            if (++count < burst) {

                suppressed = false;
                var before = clock.now();
                cache = self.search(query);
                var ret = immediate_cb(cache);
                var now = clock.now();

                //try to learn  typical time (time mult factor);
                wait = 0.5 * wait + 0.5 * mult * (now - before);
                //console.log(wait);
                return ret;

            } else {
                suppressed = true;
                //console.log("supress");
                return suppress_cb(cache);
            }
        }

    },

    /**
     * Allow the FuzzySearch object to be given as a source to twitter typeahead.
     * This implement similar interface than Bloodhound object.
     *
     * @returns {function({string}, function({Array}) ,function({Array}) )} Interactive version of search.
     */

    __ttAdapter: function ttAdapter() {

        var debounced = this.getInteractive();
        var noop = function (a) {
        };
        return function (query, sync, async) {
            debounced(query, sync, noop, async);
        }

    },

    /**
     * Generate a function compatible with jQuery UI auto-complete Source
     *
     * @returns {function( {Object}, {function()} )} Interactive version of search.
     */
    $uiSource: function () {

        var debounced = this.getInteractive();
        var noop = function (a) {
        };
        return function (request, response) {
            debounced(request.term, response, noop, response);
        }

    }
});
//
// Export FuzzySearch
//

if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {

    // CommonJS-like environments
    module.exports = FuzzySearch;

} else if (typeof define === 'function' && define.amd) {

    // AMD. Register as an anonymous module.
    define(function () {
        return FuzzySearch;
    });

} else {

    // Browser globals
    window['FuzzySearch'] = FuzzySearch;

}

return FuzzySearch;

})();