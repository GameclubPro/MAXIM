// FLAG: Production activation is quarantined until all-role effect quiescence,
// unknown-result recovery and bounded actionable-lag settlement are proven.
// There is no caller or environment override. Existing hold readers remain mandatory.
export const LEGACY_COLD_ACTIVATION_REFUSAL = 'cold_activation_disabled';

if (require.main === module) {
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      applied: false,
      refused: true,
      code: LEGACY_COLD_ACTIVATION_REFUSAL,
    })}\n`,
  );
  process.stderr.write('Legacy cold recovery activation is disabled; evidence is unchanged.\n');
  process.exitCode = 1;
}
