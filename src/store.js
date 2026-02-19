/**
 * IsoCity Item Store
 * Browse and purchase items from the sprite registry
 */

// Contract ABIs (minimal required functions)
const SPRITE_REGISTRY_ABI = [
    "function getActiveSprites() view returns (tuple(uint256 id, string uri, string collection, uint256 tokenCost, address artist, uint8 royaltyBps, bool active, bool claimable, bool walletGated, address gateToken, uint256 gateAmount, bool isERC721Gate)[])",
    "function getSprite(uint256 id) view returns (tuple(uint256 id, string uri, string collection, uint256 tokenCost, address artist, uint8 royaltyBps, bool active, bool claimable, bool walletGated, address gateToken, uint256 gateAmount, bool isERC721Gate))",
    "function getCollections() view returns (string[])",
    "function getSpritesByCollection(string name) view returns (uint256[])",
    "function canUseSprite(uint256 id, address wallet) view returns (bool)",
    "function isFreeSprite(uint256 id) view returns (bool)",
    "function requiresOwnership(uint256 id) view returns (bool)"
];

const ITEM_REGISTRY_ABI = [
    "function claimFree(uint256 spriteId) returns (uint256)",
    "function mintPremium(uint256 spriteId) returns (uint256)",
    "function getOwnerItems(address owner) view returns (uint256[])",
    "function ownsSprite(address owner, uint256 spriteId) view returns (bool)",
    "function hasClaimed(address owner, uint256 spriteId) view returns (bool)",
    "function getListedItems() view returns (uint256[])",
    "function getListedItemsDetailed() view returns (tuple(uint256 spriteId, address owner, uint256 mintedAt, bool listed, uint256 listPrice)[])",
    "function buy(uint256 itemId)"
];

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

class IsoCityStore {
    constructor(config = {}) {
        this.config = {
            spriteRegistryAddress: config.spriteRegistryAddress || null,
            itemRegistryAddress: config.itemRegistryAddress || null,
            tokenAddress: config.tokenAddress || null,
            rpcUrl: config.rpcUrl || 'https://mainnet.base.org',
            chainId: config.chainId || 8453,
            ...config
        };

        this.provider = null;
        this.signer = null;
        this.walletAddress = null;

        this.spriteRegistry = null;
        this.itemRegistry = null;
        this.token = null;

        this.sprites = [];
        this.collections = [];
        this.ownedItems = [];
        this.listedItems = [];

        this.currentFilter = 'all';
        this.currentCollection = null;

        // Event callbacks
        this.onConnect = null;
        this.onDisconnect = null;
        this.onSpritesLoaded = null;
        this.onError = null;
    }

    /**
     * Get provider (Phantom-aware)
     */
    getProvider() {
        if (typeof window === 'undefined') return null;
        if (window.phantom?.ethereum) return window.phantom.ethereum;
        if (window.ethereum) return window.ethereum;
        return null;
    }

    /**
     * Initialize store with wallet connection
     */
    async init() {
        // Check for wallet provider
        if (this.getProvider()) {
            await this.connectWallet();
        }

        // Load sprites from local cache if no contracts configured
        if (!this.config.spriteRegistryAddress) {
            await this.loadLocalSprites();
        }
    }

    /**
     * Connect to wallet
     */
    async connectWallet() {
        try {
            const eth = this.getProvider();
            if (!eth) {
                throw new Error('No wallet detected - install Phantom or MetaMask');
            }

            // Request accounts
            const accounts = await eth.request({
                method: 'eth_requestAccounts'
            });

            this.walletAddress = accounts[0];

            // Setup ethers provider
            const { ethers } = await import('https://esm.sh/ethers@6');

            this.provider = new ethers.BrowserProvider(eth);
            this.signer = await this.provider.getSigner();

            // Initialize contracts if addresses provided
            if (this.config.spriteRegistryAddress) {
                this.spriteRegistry = new ethers.Contract(
                    this.config.spriteRegistryAddress,
                    SPRITE_REGISTRY_ABI,
                    this.signer
                );
            }

            if (this.config.itemRegistryAddress) {
                this.itemRegistry = new ethers.Contract(
                    this.config.itemRegistryAddress,
                    ITEM_REGISTRY_ABI,
                    this.signer
                );
            }

            if (this.config.tokenAddress) {
                this.token = new ethers.Contract(
                    this.config.tokenAddress,
                    ERC20_ABI,
                    this.signer
                );
            }

            // Load data
            await this.loadSprites();
            await this.loadOwnedItems();

            if (this.onConnect) {
                this.onConnect(this.walletAddress);
            }

            // Listen for account changes
            eth.on('accountsChanged', (accounts) => {
                if (accounts.length === 0) {
                    this.disconnect();
                } else {
                    this.walletAddress = accounts[0];
                    this.loadOwnedItems();
                }
            });

            return this.walletAddress;
        } catch (err) {
            if (this.onError) this.onError(err);
            throw err;
        }
    }

    /**
     * Disconnect wallet
     */
    disconnect() {
        this.walletAddress = null;
        this.signer = null;
        this.ownedItems = [];

        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    /**
     * Load sprites from contract or local cache
     */
    async loadSprites() {
        try {
            if (this.spriteRegistry) {
                // Load from contract
                const activeSprites = await this.spriteRegistry.getActiveSprites();
                this.sprites = activeSprites.map(s => this.formatSprite(s));

                this.collections = await this.spriteRegistry.getCollections();
            } else {
                // Load from local cache
                await this.loadLocalSprites();
            }

            if (this.onSpritesLoaded) {
                this.onSpritesLoaded(this.sprites);
            }

            return this.sprites;
        } catch (err) {
            if (this.onError) this.onError(err);
            throw err;
        }
    }

    /**
     * Load sprites from local JSON file
     */
    async loadLocalSprites() {
        try {
            const response = await fetch('/data/sprites.json');
            const data = await response.json();

            this.sprites = data.sprites || [];
            this.collections = data.collections || [];

            if (this.onSpritesLoaded) {
                this.onSpritesLoaded(this.sprites);
            }

            return this.sprites;
        } catch (err) {
            console.warn('Could not load local sprites:', err);
            this.sprites = [];
            this.collections = [];
        }
    }

    /**
     * Format sprite from contract to JS object
     */
    formatSprite(contractSprite) {
        return {
            id: Number(contractSprite.id),
            uri: contractSprite.uri,
            collection: contractSprite.collection,
            tokenCost: contractSprite.tokenCost.toString(),
            artist: contractSprite.artist,
            royaltyBps: Number(contractSprite.royaltyBps),
            active: contractSprite.active,
            claimable: contractSprite.claimable,
            walletGated: contractSprite.walletGated,
            gateToken: contractSprite.gateToken,
            gateAmount: contractSprite.gateAmount.toString(),
            isERC721Gate: contractSprite.isERC721Gate
        };
    }

    /**
     * Load owned items for connected wallet
     */
    async loadOwnedItems() {
        if (!this.walletAddress || !this.itemRegistry) {
            this.ownedItems = [];
            return [];
        }

        try {
            const itemIds = await this.itemRegistry.getOwnerItems(this.walletAddress);
            this.ownedItems = itemIds.map(id => Number(id));
            return this.ownedItems;
        } catch (err) {
            if (this.onError) this.onError(err);
            this.ownedItems = [];
            return [];
        }
    }

    /**
     * Get filtered sprites based on current filter
     */
    getFilteredSprites() {
        let filtered = [...this.sprites];

        // Filter by collection
        if (this.currentCollection) {
            filtered = filtered.filter(s => s.collection === this.currentCollection);
        }

        // Filter by type
        switch (this.currentFilter) {
            case 'free':
                filtered = filtered.filter(s => s.tokenCost === '0' && !s.claimable);
                break;
            case 'claimable':
                filtered = filtered.filter(s => s.claimable);
                break;
            case 'premium':
                filtered = filtered.filter(s => s.tokenCost !== '0');
                break;
            case 'wallet-gated':
                filtered = filtered.filter(s => s.walletGated);
                break;
            case 'artist':
                filtered = filtered.filter(s => s.artist !== '0x0000000000000000000000000000000000000000');
                break;
            default:
                // 'all' - no filter
                break;
        }

        return filtered;
    }

    /**
     * Set current filter
     */
    setFilter(filter) {
        this.currentFilter = filter;
    }

    /**
     * Set current collection filter
     */
    setCollection(collection) {
        this.currentCollection = collection;
    }

    /**
     * Check if wallet can use a sprite
     */
    async canUse(spriteId) {
        if (!this.walletAddress) return false;

        const sprite = this.sprites.find(s => s.id === spriteId);
        if (!sprite) return false;

        // Free sprites - always usable
        if (sprite.tokenCost === '0' && !sprite.claimable && !sprite.walletGated) {
            return true;
        }

        // Check wallet gate
        if (sprite.walletGated && this.spriteRegistry) {
            return await this.spriteRegistry.canUseSprite(spriteId, this.walletAddress);
        }

        // Check ownership for claimable/premium
        if (sprite.claimable || sprite.tokenCost !== '0') {
            if (this.itemRegistry) {
                return await this.itemRegistry.ownsSprite(this.walletAddress, spriteId);
            }
            return false;
        }

        return true;
    }

    /**
     * Claim a free claimable sprite
     */
    async claimSprite(spriteId) {
        if (!this.itemRegistry || !this.walletAddress) {
            throw new Error('Not connected');
        }

        const sprite = this.sprites.find(s => s.id === spriteId);
        if (!sprite || !sprite.claimable) {
            throw new Error('Sprite not claimable');
        }

        // Check if already claimed
        const hasClaimed = await this.itemRegistry.hasClaimed(this.walletAddress, spriteId);
        if (hasClaimed) {
            throw new Error('Already claimed');
        }

        const tx = await this.itemRegistry.claimFree(spriteId);
        const receipt = await tx.wait();

        await this.loadOwnedItems();

        return receipt;
    }

    /**
     * Purchase a premium sprite
     */
    async purchaseSprite(spriteId) {
        if (!this.itemRegistry || !this.token || !this.walletAddress) {
            throw new Error('Not connected');
        }

        const sprite = this.sprites.find(s => s.id === spriteId);
        if (!sprite || sprite.tokenCost === '0') {
            throw new Error('Sprite is not premium');
        }

        const cost = BigInt(sprite.tokenCost);

        // Check balance
        const balance = await this.token.balanceOf(this.walletAddress);
        if (balance < cost) {
            throw new Error('Insufficient balance');
        }

        // Check/set allowance
        const allowance = await this.token.allowance(this.walletAddress, this.config.itemRegistryAddress);
        if (allowance < cost) {
            const approveTx = await this.token.approve(this.config.itemRegistryAddress, cost);
            await approveTx.wait();
        }

        // Mint
        const tx = await this.itemRegistry.mintPremium(spriteId);
        const receipt = await tx.wait();

        await this.loadOwnedItems();

        return receipt;
    }

    /**
     * Get token balance
     */
    async getTokenBalance() {
        if (!this.token || !this.walletAddress) return '0';

        const balance = await this.token.balanceOf(this.walletAddress);
        return balance.toString();
    }

    /**
     * Format token amount for display
     */
    formatTokenAmount(amount, decimals = 18) {
        const value = BigInt(amount);
        const divisor = BigInt(10 ** decimals);
        const intPart = value / divisor;
        const fracPart = value % divisor;

        if (fracPart === 0n) {
            return intPart.toString();
        }

        const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, 4);
        return `${intPart}.${fracStr}`;
    }

    /**
     * Get sprite type label
     */
    getSpriteTypeLabel(sprite) {
        if (sprite.tokenCost !== '0') {
            return 'Premium';
        }
        if (sprite.claimable) {
            return 'Free Claimable';
        }
        if (sprite.walletGated) {
            return 'Wallet-Gated';
        }
        if (sprite.artist !== '0x0000000000000000000000000000000000000000') {
            return 'Artist';
        }
        return 'Free';
    }

    /**
     * Get sprite cost display
     */
    getSpriteCostDisplay(sprite) {
        if (sprite.tokenCost === '0') {
            if (sprite.claimable) return 'Gas Only';
            return 'Free';
        }
        return `${this.formatTokenAmount(sprite.tokenCost)} $ISOCITY`;
    }
}

// Export for use in browser
if (typeof window !== 'undefined') {
    window.IsoCityStore = IsoCityStore;
}

export default IsoCityStore;
