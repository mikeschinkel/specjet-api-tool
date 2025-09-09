import MockServer from '../mock-server/server.js';
import ContractParser from '../core/parser.js';
import ConfigLoader from '../core/config.js';
import { ErrorHandler, SpecJetError } from '../core/errors.js';

async function mockCommand(options = {}) {
  return ErrorHandler.withErrorHandling(async () => {
    console.log('🎭 Starting mock server...\n');

    // 1. Load configuration
    console.log('📋 Loading configuration...');
    const config = await ConfigLoader.loadConfig(options.config);
    ConfigLoader.validateConfig(config);
    
    const contractPath = ConfigLoader.resolveContractPath(config);
    ErrorHandler.validateContractFile(contractPath);
    console.log(`   Contract: ${contractPath}`);

    // 2. Parse OpenAPI contract
    console.log('\n📖 Parsing OpenAPI contract...');
    const parser = new ContractParser();
    let parsedContract;
    try {
      parsedContract = await parser.parseContract(contractPath);
    } catch (error) {
      throw SpecJetError.contractInvalid(contractPath, error);
    }
    
    console.log(`   Found ${Object.keys(parsedContract.schemas).length} schemas`);
    console.log(`   Found ${parsedContract.endpoints.length} endpoints`);

    // 3. Setup mock server
    const port = ErrorHandler.validatePort(options.port || config.mock?.port || 3001);
    const scenario = options.scenario || config.mock?.scenario || 'demo';
    
    // Validate scenario
    const validScenarios = ['demo', 'realistic', 'large', 'errors'];
    if (!validScenarios.includes(scenario)) {
      throw new SpecJetError(
        `Invalid scenario: ${scenario}`,
        'INVALID_SCENARIO',
        null,
        [
          `Valid scenarios are: ${validScenarios.join(', ')}`,
          'Use --scenario demo for small predictable data',
          'Use --scenario realistic for varied realistic data',
          'Use --scenario large for performance testing',
          'Use --scenario errors for testing error handling'
        ]
      );
    }
    
    console.log(`\n🔧 Configuring mock server...`);
    console.log(`   Port: ${port}`);
    console.log(`   Scenario: ${scenario}`);
    console.log(`   CORS: enabled (always)`);

    // 4. Start mock server
    console.log('\n🚀 Starting mock server...');
    const mockServer = new MockServer(parsedContract, scenario);

    let serverUrl;
    try {
      serverUrl = await mockServer.start(port);
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        throw SpecJetError.portInUse(port);
      }
      throw new SpecJetError(
        `Failed to start mock server: ${error.message}`,
        'SERVER_START_FAILED',
        error,
        [
          'Check if another process is using the port',
          'Try a different port with --port option',
          'Ensure you have permission to bind to the port'
        ]
      );
    }

    console.log(`\n✅ Mock server running successfully!`);
    console.log(`   🌐 Server: ${serverUrl}`);
    console.log(`\n💡 Tips:`);
    console.log(`   • Try different scenarios: --scenario realistic|large|errors`);
    console.log(`   • For API documentation, run: specjet docs --port 3002`);
    console.log(`\n📊 Endpoints available:`);
    
    parsedContract.endpoints.forEach(ep => {
      console.log(`   ${ep.method.padEnd(6)} ${ep.path}${ep.summary ? ` - ${ep.summary}` : ''}`);
    });

    console.log('\n🛑 Press Ctrl+C to stop the server');

    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\n\n👋 Shutting down mock server...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n\n👋 Shutting down mock server...');
      process.exit(0);
    });
  }, options);
}

export default mockCommand;