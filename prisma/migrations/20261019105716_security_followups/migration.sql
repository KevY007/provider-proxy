-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "trialCardFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "User_trialCardFingerprint_idx" ON "User"("trialCardFingerprint");
