// Tiny sample project with one seeded bug for the agent-loop demo.
function totalWithDiscount(items, discountPct) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return subtotal - discountPct; // BUG: treats a percent as a flat amount
}
module.exports = { totalWithDiscount };
