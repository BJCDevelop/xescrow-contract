import { ethers } from "hardhat";

async function main() {
  // 1. Check network connection
  const network = await ethers.provider.getNetwork();
  console.log("🔗 Conectado a la red:", network.name, "ID:", network.chainId);

  // 2. Verify signers exist
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("❌ No se encontraron cuentas. Verifica la configuración de la red.");
  }
  
  const deployer = signers[0];
  console.log("🔵 Desplegando contratos con la cuenta:", deployer.address);
  console.log("💸 Saldo inicial:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 3. Deploy contract
  const Xescrow = await ethers.getContractFactory("Xescrow");
  console.log("⚙️ Creando instancia de fábrica de contratos...");
  
  const xescrow = await Xescrow.deploy();
  console.log("⏳ Esperando confirmación de despliegue...");
  
  await xescrow.waitForDeployment();
  const xescrowAddress = await xescrow.getAddress();
  
  console.log("✅ Xescrow desplegado en:", xescrowAddress);
  console.log("👑 Propietario del contrato:", await xescrow.owner());
}

main().catch((error) => {
  console.error("❌ Error crítico:", error);
  process.exitCode = 1;
});