import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Importa los matchers de Hardhat-Chai para extender expect y enseñarle a TypeScript sobre ellos
import "@nomicfoundation/hardhat-chai-matchers";

// --- IMPORTACIÓN DE TIPOS ---
// Importamos el tipo del contrato, generado automáticamente por TypeChain
import { Xescrow } from "../typechain-types"; 
// Importamos el tipo para los firmantes (wallets) de Hardhat
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// IMPORTAR parseEther desde ethers.js (librería oficial)
import { parseEther } from "ethers";

describe("----------------Xescrow---------------- EXTENSIVE TESTS for The Cookathon of Mantle Network", function () {
  // --- ANOTACIONES DE TIPO AÑADIDAS ---
  let xescrow: Xescrow;
  let owner: SignerWithAddress;
  let client: SignerWithAddress;
  let provider: SignerWithAddress;
  let juror1: SignerWithAddress;
  let juror2: SignerWithAddress;
  let otherUser: SignerWithAddress;

  // Usamos un enum o un objeto para mayor claridad en lugar de números mágicos
  const Roles = {
    None: 0,
    Client: 1,
    Provider: 2,
    Juror: 3,
  };

  const OfferStatuses = {
    Open: 0,
    Accepted: 1,
    Completed: 2,
    Cancelled: 3,
    Disputed: 4,
    Resolved: 5,
  };

  async function deployFixture() {
    [owner, client, provider, juror1, juror2, otherUser] = await ethers.getSigners();
    const XescrowFactory = await ethers.getContractFactory("Xescrow");
    xescrow = await XescrowFactory.deploy();
    await xescrow.waitForDeployment();
    return { xescrow, owner, client, provider, juror1, juror2, otherUser };
  }

  describe("User Registration", function () {
    beforeEach(async function () {
      await deployFixture();
    });

    it("Should register users with valid roles and emit event", async function () {
      await expect(xescrow.connect(client).registerUser(Roles.Client))
        .to.emit(xescrow, "UserRegistered")
        .withArgs(client.address, Roles.Client);
      const user = await xescrow.users(client.address);
      expect(user.role).to.equal(Roles.Client);
      expect(user.registered).to.be.true;
    });

    it("Should reject registration with invalid role (None)", async function () {
      await expect(xescrow.connect(client).registerUser(Roles.None)).to.be.revertedWith("Invalid role");
    });

    it("Should reject registration if already registered", async function () {
      await xescrow.connect(client).registerUser(Roles.Client);
      await expect(xescrow.connect(client).registerUser(Roles.Client)).to.be.revertedWith("Already registered");
    });
  });

  describe("Offer Creation", function () {
     beforeEach(async function () {
      const { provider } = await deployFixture();
      await xescrow.connect(provider).registerUser(Roles.Provider);
    });

    it("Should create an offer and emit an event", async function () {
      const price = parseEther("1");
      await expect(xescrow.connect(provider).createServiceOffer("descHash", price, 3600))
        .to.emit(xescrow, "OfferCreated")
        .withArgs(0, provider.address, price, "descHash");
      
      const offer = await xescrow.offers(0);
      expect(offer.provider).to.equal(provider.address);
      expect(offer.price).to.equal(price);
      expect(offer.status).to.equal(OfferStatuses.Open);
    });

    it("Should reject creation with zero price", async function () {
      await expect(xescrow.connect(provider).createServiceOffer("descHash", 0, 3600)).to.be.revertedWith("Price must be > 0");
    });

    it("Should reject creation by a non-Provider", async function () {
      await xescrow.connect(client).registerUser(Roles.Client);
      await expect(xescrow.connect(client).createServiceOffer("descHash", parseEther("1"), 3600)).to.be.revertedWith("Only providers");
    });
  });

  describe("Offer Lifecycle: Acceptance, Delivery, and Confirmation", function () {
    const price = parseEther("1");

    beforeEach(async function () {
      await deployFixture();
      await xescrow.connect(provider).registerUser(Roles.Provider);
      await xescrow.connect(client).registerUser(Roles.Client);
      await xescrow.connect(provider).createServiceOffer("descHash", price, 3600);
    });

    it("Should allow a client to accept an offer", async function () {
      await expect(xescrow.connect(client).acceptOffer(0, { value: price }))
        .to.emit(xescrow, "OfferAccepted")
        .withArgs(0, client.address);

      const offer = await xescrow.offers(0);
      expect(offer.client).to.equal(client.address);
      expect(offer.status).to.equal(OfferStatuses.Accepted);
      expect(offer.acceptedAt).to.be.gt(0);
    });

    it("Should reject acceptance with incorrect payment", async function () {
      await expect(xescrow.connect(client).acceptOffer(0, { value: parseEther("0.5") })).to.be.revertedWith("Incorrect payment");
    });

    it("Should allow the provider to submit proof of delivery", async function() {
      await xescrow.connect(client).acceptOffer(0, { value: price });
      await expect(xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment"))
        .to.emit(xescrow, "ProofSubmitted")
        .withArgs(0, "proofHash", "comment");
      
      const offer = await xescrow.offers(0);
      expect(offer.deliveryProofHash).to.equal("proofHash");
    });

    it("Should allow the client to confirm delivery and transfer funds", async function() {
      await xescrow.connect(client).acceptOffer(0, { value: price });
      await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");

      await expect(xescrow.connect(client).confirmDelivery(0))
        .to.emit(xescrow, "DeliveryConfirmed")
        .withArgs(0);

      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(OfferStatuses.Completed); 
      expect(await xescrow.pendingWithdrawals(provider.address)).to.equal(parseEther("0.98")); // 1 ETH - 2% fee
      expect(await xescrow.platformFees()).to.equal(parseEther("0.02")); // 2% fee
    });

    it("Should reject confirmation after timeout", async function () {
      await xescrow.connect(client).acceptOffer(0, { value: price });
      await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");
      
      await time.increase(3601); // Increase time by more than the timeout

      await expect(xescrow.connect(client).confirmDelivery(0)).to.be.revertedWith("Delivery timeout");
    });
  });

  describe("Disputes and Voting", function () {
    const price = parseEther("1");

    beforeEach(async function () {
      await deployFixture();
      await xescrow.connect(provider).registerUser(Roles.Provider);
      await xescrow.connect(client).registerUser(Roles.Client);
      await xescrow.connect(juror1).registerUser(Roles.Juror);
      await xescrow.connect(juror2).registerUser(Roles.Juror);
      await xescrow.connect(provider).createServiceOffer("descHash", price, 3600);
      await xescrow.connect(client).acceptOffer(0, { value: price });
      await time.increase(3601); // Go past the delivery timeout
    });

    it("Should allow a participant to initiate a dispute", async function () {
      await expect(xescrow.connect(client).disputeOffer(0))
        .to.emit(xescrow, "OfferDisputed")
        .withArgs(0);

      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(OfferStatuses.Disputed);
    });

    it("Should allow jurors to vote and resolve the dispute", async function () {
      await xescrow.connect(client).disputeOffer(0);
      
      await expect(xescrow.connect(juror1).voteDispute(0, client.address))
        .to.emit(xescrow, "VoteCast")
        .withArgs(0, juror1.address, client.address);
      
      // The second vote for the same party should resolve the dispute
      await expect(xescrow.connect(juror2).voteDispute(0, client.address))
        .to.emit(xescrow, "DisputeResolved")
        .withArgs(0, client.address);

      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(OfferStatuses.Resolved);
    });

    it("Should distribute funds correctly after dispute resolution (Client wins)", async function () {
      await xescrow.connect(client).disputeOffer(0);
      await xescrow.connect(juror1).voteDispute(0, client.address);
      await xescrow.connect(juror2).voteDispute(0, client.address);

      // Client wins: 1 ETH - 2% platform fee - 10% juror reward = 0.88 ETH
      expect(await xescrow.pendingWithdrawals(client.address)).to.equal(parseEther("0.88"));
      // Juror reward: 10% / 2 jurors = 0.05 ETH each
      expect(await xescrow.pendingWithdrawals(juror1.address)).to.equal(parseEther("0.05"));
      expect(await xescrow.pendingWithdrawals(juror2.address)).to.equal(parseEther("0.05"));
      // Platform fee: 2%
      expect(await xescrow.platformFees()).to.equal(parseEther("0.02"));
    });

     it("Should reject voting by a non-juror", async function () {
      await xescrow.connect(client).disputeOffer(0);
      await expect(xescrow.connect(otherUser).voteDispute(0, client.address)).to.be.revertedWith("Not registered");
      
      // Conectamos como proveedor para el siguiente chequeo
      const providerSigner = provider;
      await expect(xescrow.connect(providerSigner).voteDispute(0, client.address)).to.be.revertedWith("Only jurors");
    });
  });

  describe("Withdrawals", function () {
    const price = parseEther("1");

    beforeEach(async function() {
        await deployFixture();
        await xescrow.connect(provider).registerUser(Roles.Provider);
        await xescrow.connect(client).registerUser(Roles.Client);
        await xescrow.connect(provider).createServiceOffer("descHash", price, 3600);
        await xescrow.connect(client).acceptOffer(0, { value: price });
        await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");
        await xescrow.connect(client).confirmDelivery(0);
    });

    it("Should allow a user to withdraw their pending funds", async function () {
      const amountToWithdraw = parseEther("0.98");
      // Check that withdrawing funds changes the user's balance correctly
      await expect(xescrow.connect(provider).withdrawFunds())
        .to.changeEtherBalances([provider, xescrow], [amountToWithdraw, -amountToWithdraw]);
      
      expect(await xescrow.pendingWithdrawals(provider.address)).to.equal(0);
    });

    it("Should allow the owner to withdraw platform fees", async function () {
      const feeAmount = parseEther("0.02");
      await expect(xescrow.connect(owner).withdrawPlatformFees(owner.address))
        .to.changeEtherBalances([owner, xescrow], [feeAmount, -feeAmount]);

      expect(await xescrow.platformFees()).to.equal(0);
    });

    it("Should reject fee withdrawal by a non-Owner", async function () {
      await expect(xescrow.connect(client).withdrawPlatformFees(client.address)).to.be.revertedWith("Only owner");
    });
  });
});
