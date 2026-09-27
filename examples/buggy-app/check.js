const { totalWithDiscount } = require('./discount.js');
const got = totalWithDiscount([{ price: 200, qty: 2 }, { price: 100, qty: 1 }], 10);
if (got !== 450) { console.error(`FAIL: expected 450, got ${got}`); process.exit(1); }
console.log('PASS: total is 450');
