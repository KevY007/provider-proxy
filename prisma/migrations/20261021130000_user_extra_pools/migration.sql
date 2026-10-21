-- Private pools an admin allowed a customer to put API keys in (besides their own pool).
ALTER TABLE "User" ADD COLUMN "extraGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
