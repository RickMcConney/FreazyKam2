// Arithmetic in a numeric field: `=24/2` puts 12 in the box.
//
// This is `parseNumeric`'s own rule one level up — once the text opens with `=`, the ONLY
// acceptable reading is an expression. There is no falling back to `parseFloat`, no
// partial credit, and no taking the part it understood: an expression either evaluates to
// a finite number or the field keeps the value it already had. Same reasoning as the
// slash rule, and the same stakes — a field that drives a cut must never accept the
// leading digits of something it did not understand.
//
// WHAT `=` CHANGES ABOUT `-`. Without it, `1-1/2` is one and a half: the hyphen is a
// mixed-number separator, which is how a shop writes it. Inside an expression that same
// text is subtraction, so `=1-1/2` is 0.5. Both readings are right for their own notation
// and neither can serve the other, so `=` is the switch between them — which is also why
// the everyday `1/2` still needs no `=` at all, division and fraction being the same
// number. `1 1/2` has no expression reading (two operands, no operator) and is rejected
// rather than guessed at.
//
// Deliberately absent: units inside the expression (`=6mm + 1in`), functions, and any
// reference to a named variable or another field. Those belong to the variables work this
// is the precursor of; each wants a type system or a dependency graph, and none of it is
// needed to divide a number by two. The parser is hand-written for the same reason
// `parseNumeric` is: `new Function` on this text would execute whatever a `.fkam` someone
// shared happened to carry, once formulas start being stored.

// Grammar — recursive descent, one character of lookahead:
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('+' | '-') unary | power
//   power   := primary ('^' unary)?
//   primary := number | '(' expr ')'
//
// `unary` sits ABOVE `power` on the left and below it on the right, which is what makes
// `-2^2` read as -(2^2) = -4 and `2^-1` read as 0.5, both the way they are written on
// paper. `^` right-associates, so `2^3^2` is 2^9.

/** Nesting cap. A typed field cannot reach it; a pasted `((((…` must not overflow the stack. */
const MAX_DEPTH = 32

/**
 * Evaluate the body of an `=` expression (the `=` itself already stripped).
 *
 * Returns null for anything that is not one finite number: a syntax error, trailing text,
 * a division by zero, or a result JS cannot represent. Null means "the field does not
 * change", never "use what I could salvage".
 */
export function evalExpression(src: string): number | null {
  let i = 0
  let depth = 0

  const skipWs = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++ }
  const peek = () => { skipWs(); return i < src.length ? src[i] : '' }
  const eat = (ch: string) => { if (peek() === ch) { i++; return true } return false }

  function primary(): number | null {
    if (++depth > MAX_DEPTH) return null
    try {
      if (eat('(')) {
        const v = expr()
        if (v === null || !eat(')')) return null
        return v
      }
      skipWs()
      const start = i
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
      if (src[i] === '.') {
        i++
        while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
      }
      if (i === start) return null            // neither a number nor a bracket
      const v = parseFloat(src.slice(start, i))   // '.' alone yields NaN, caught below
      return Number.isFinite(v) ? v : null
    } finally {
      depth--
    }
  }

  function power(): number | null {
    const base = primary()
    if (base === null) return null
    if (!eat('^')) return base
    const exp = unary()                       // right-associative, and `2^-1` is legal
    if (exp === null) return null
    const v = base ** exp
    return Number.isFinite(v) ? v : null      // (-8)^(1/3) is NaN, not a cube root
  }

  function unary(): number | null {
    if (eat('-')) { const v = unary(); return v === null ? null : -v }
    if (eat('+')) return unary()
    return power()
  }

  function term(): number | null {
    let left = unary()
    if (left === null) return null
    for (;;) {
      const op = peek()
      if (op !== '*' && op !== '/') return left
      i++
      const right = unary()
      if (right === null) return null
      // Explicit, rather than leaning on the finite check at the end: `=1/0` must be
      // refused for the same reason `1/0` is, and Infinity must never reach a field.
      if (op === '/' && right === 0) return null
      left = op === '*' ? left * right : left / right
    }
  }

  function expr(): number | null {
    let left = term()
    if (left === null) return null
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') return left
      i++
      const right = term()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
    }
  }

  const v = expr()
  skipWs()
  if (v === null || i < src.length) return null   // trailing text is an error, not a suffix
  return Number.isFinite(v) ? v : null
}
