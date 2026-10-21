-- Long-context surcharge with a separate output multiplier (OpenAI above 272K input: input 2x, output 1.5x).
ALTER TABLE "Model" ADD COLUMN "longContextOutputMultiplier" DECIMAL(10,4);
