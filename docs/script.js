const button = document.getElementById('copy');
button?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('npm run demo'); button.textContent = 'Copied'; }
  catch { button.textContent = 'Copy: npm run demo'; }
  setTimeout(() => { button.textContent = 'Copy'; }, 1800);
});
