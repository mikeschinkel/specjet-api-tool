import ContractParser from './parser.js';
import ParameterDiscovery from './parameter-discovery.js';
import { SpecJetError } from './errors.js';

/**
 * Focused API validator with single responsibility
 * Handles only individual endpoint validation, delegates other concerns
 */
class APIValidator {
  constructor(dependencies = {}) {
    this.httpClient = dependencies.httpClient;
    this.schemaValidator = dependencies.schemaValidator;
    this.logger = dependencies.logger || console;

    // Validation state
    this.contract = null;
    this.endpoints = null;
    this.contractPath = null;

    // Parameter discovery service
    this.parameterDiscovery = new ParameterDiscovery({
      httpClient: this.httpClient,
      logger: this.logger
    });

    // Validate required dependencies
    if (!this.httpClient) {
      throw new SpecJetError(
        'HTTPClient dependency is required',
        'MISSING_DEPENDENCY',
        null,
        ['Provide an httpClient instance when creating APIValidator']
      );
    }

    if (!this.schemaValidator) {
      throw new SpecJetError(
        'SchemaValidator dependency is required',
        'MISSING_DEPENDENCY',
        null,
        ['Provide a schemaValidator instance when creating APIValidator']
      );
    }
  }

  /**
   * Initialize the validator with a contract
   * @param {string} contractPath - Path to the OpenAPI contract
   */
  async initialize(contractPath) {
    try {
      this.contractPath = contractPath;
      const parser = new ContractParser();
      this.contract = await parser.parseContract(contractPath);
      this.endpoints = this.contract.endpoints;

      this.logger.log(`✅ Loaded contract: ${this.contract.info.title} v${this.contract.info.version}`);
      this.logger.log(`📊 Found ${this.endpoints.length} endpoints to validate`);
    } catch (error) {
      throw new SpecJetError(
        `Failed to initialize validator with contract: ${contractPath}`,
        'VALIDATOR_INIT_ERROR',
        error,
        [
          'Check that the contract file exists and is valid OpenAPI',
          'Verify the contract path is correct',
          'Run with --verbose for detailed error information'
        ]
      );
    }
  }

  /**
   * Validate a single endpoint
   * @param {string} path - Endpoint path
   * @param {string} method - HTTP method
   * @param {object} options - Validation options
   * @returns {Promise<object>} Validation result
   */
  async validateEndpoint(path, method, options = {}) {
    if (!this.contract) {
      throw new SpecJetError(
        'Validator not initialized. Call initialize() first.',
        'VALIDATOR_NOT_INITIALIZED'
      );
    }

    const endpoint = this.findEndpoint(path, method);
    if (!endpoint) {
      return this.createNotFoundResult(path, method);
    }

    try {
      // Smart parameter discovery for unresolved parameters
      const discoveredParams = await this.discoverPathParameters(
        path,
        options.pathParams || {},
        options.enableParameterDiscovery !== false // Default to enabled
      );

      // Resolve path parameters in the URL
      const resolvedPath = this.resolvePath(path, discoveredParams);

      // Generate request body for POST/PUT operations
      const requestBody = await this.generateRequestBody(endpoint, options.requestBody);

      // Make HTTP request to the live API
      const response = await this.httpClient.makeRequest(
        resolvedPath,
        method,
        {
          query: options.queryParams,
          body: requestBody,
          timeout: options.timeout
        }
      );

      // Validate the response against the contract
      const issues = await this.validateResponse(endpoint, response);

      return this.createValidationResult(
        path,
        method,
        issues.length === 0,
        response.status,
        issues,
        {
          responseTime: response.responseTime,
          responseSize: response.data ? JSON.stringify(response.data).length : 0
        }
      );
    } catch (error) {
      return this.createNetworkErrorResult(path, method, error);
    }
  }

  /**
   * Find endpoint definition in contract
   * @param {string} path - Endpoint path
   * @param {string} method - HTTP method
   * @returns {object|null} Endpoint definition
   */
  findEndpoint(path, method) {
    return this.endpoints.find(ep =>
      ep.path === path && ep.method.toUpperCase() === method.toUpperCase()
    );
  }

  /**
   * Discover missing path parameters using smart discovery
   * @param {string} pathTemplate - Path template with {param} placeholders
   * @param {object} providedParams - User-provided parameters
   * @param {boolean} enableDiscovery - Whether to enable automatic discovery
   * @returns {Promise<object>} Complete parameter set
   */
  async discoverPathParameters(pathTemplate, providedParams, enableDiscovery = true) {
    if (!enableDiscovery) {
      return providedParams;
    }

    try {
      const discoveredParams = await this.parameterDiscovery.discoverParameters(
        pathTemplate,
        this.endpoints || [],
        providedParams
      );

      // Log discovered parameters for transparency
      const newParams = {};
      for (const [key, value] of Object.entries(discoveredParams)) {
        if (!Object.prototype.hasOwnProperty.call(providedParams, key)) {
          newParams[key] = value;
        }
      }

      if (Object.keys(newParams).length > 0) {
        this.logger.log(
          `🔍 Auto-discovered parameters: ${Object.entries(newParams)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        );
      }

      return discoveredParams;
    } catch (error) {
      this.logger.warn(`⚠️  Parameter discovery failed: ${error.message}`);
      return providedParams; // Fall back to provided parameters only
    }
  }

  /**
   * Resolve path parameters in URL template
   * @param {string} pathTemplate - URL template with {param} placeholders
   * @param {object} pathParams - Parameter values
   * @returns {string} Resolved URL
   */
  resolvePath(pathTemplate, pathParams) {
    let resolvedPath = pathTemplate;

    // Replace {param} with actual values
    for (const [key, value] of Object.entries(pathParams)) {
      resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
    }

    // Check for unresolved parameters
    const unresolvedParams = resolvedPath.match(/\{([^}]+)\}/g);
    if (unresolvedParams) {
      throw new Error(`Unresolved path parameters: ${unresolvedParams.join(', ')}`);
    }

    return resolvedPath;
  }

  /**
   * Generate request body from schema or use provided body
   * @param {object} endpoint - Endpoint definition
   * @param {*} providedBody - User-provided request body
   * @returns {Promise<*>} Request body
   */
  async generateRequestBody(endpoint, providedBody) {
    if (!endpoint.requestBody || !endpoint.requestBody.schema) {
      return null;
    }

    if (providedBody) {
      return providedBody;
    }

    // Generate minimal valid request body from schema
    return this.schemaValidator.generateSampleData(endpoint.requestBody.schema);
  }

  /**
   * Validate response against contract specification
   * @param {object} endpoint - Endpoint definition
   * @param {object} response - HTTP response
   * @returns {Promise<Array>} Array of validation issues
   */
  async validateResponse(endpoint, response) {
    const issues = [];
    const statusCode = response.status.toString();

    const responseSpec = this.findResponseSpecification(endpoint, statusCode);

    if (!responseSpec) {
      issues.push(this.createUnexpectedStatusCodeIssue(statusCode, endpoint));
      return issues;
    }

    const schemaIssues = await this.validateResponseSchema(responseSpec, response);
    issues.push(...schemaIssues);

    const headerIssues = this.validateResponseHeaders(responseSpec, response);
    issues.push(...headerIssues);

    return issues;
  }

  /**
   * Find appropriate response specification for status code
   * @param {object} endpoint - Endpoint definition
   * @param {string} statusCode - HTTP status code
   * @returns {object|null} Response specification
   */
  findResponseSpecification(endpoint, statusCode) {
    let responseSpec = endpoint.responses[statusCode];

    if (!responseSpec) {
      responseSpec = this.findFallbackResponseSpec(endpoint, statusCode);
    }

    return responseSpec;
  }

  /**
   * Find fallback response specification using smart matching
   * @param {object} endpoint - Endpoint definition
   * @param {string} statusCode - HTTP status code
   * @returns {object|null} Fallback response specification
   */
  findFallbackResponseSpec(endpoint, statusCode) {
    // Smart fallback for common success status codes
    if (statusCode === '201' && endpoint.responses['200']) {
      this.logger.log(`🔄 Using 200 response spec for 201 status code (${endpoint.method} ${endpoint.path})`);
      return endpoint.responses['200'];
    } else if (statusCode === '200' && endpoint.responses['201']) {
      this.logger.log(`🔄 Using 201 response spec for 200 status code (${endpoint.method} ${endpoint.path})`);
      return endpoint.responses['201'];
    }

    // Fall back to default response
    return endpoint.responses['default'];
  }

  /**
   * Create issue for unexpected status code
   * @param {string} statusCode - Actual status code
   * @param {object} endpoint - Endpoint definition
   * @returns {object} Validation issue
   */
  createUnexpectedStatusCodeIssue(statusCode, endpoint) {
    return this.createIssue(
      'unexpected_status_code',
      null,
      `Status code ${statusCode} not defined in contract`,
      {
        actualStatus: statusCode,
        expectedStatuses: Object.keys(endpoint.responses)
      }
    );
  }

  /**
   * Validate response schema
   * @param {object} responseSpec - Response specification
   * @param {object} response - HTTP response
   * @returns {Promise<Array>} Schema validation issues
   */
  async validateResponseSchema(responseSpec, response) {
    if (!responseSpec.schema || !response.data) {
      return [];
    }

    return await this.schemaValidator.validateResponse(
      response.data,
      responseSpec.schema
    );
  }

  /**
   * Validate response headers
   * @param {object} responseSpec - Response specification
   * @param {object} response - HTTP response
   * @returns {Array} Header validation issues
   */
  validateResponseHeaders(responseSpec, response) {
    if (!responseSpec.headers) {
      return [];
    }

    return this.validateHeaders(response.headers, responseSpec.headers);
  }

  /**
   * Validate response headers
   * @param {object} actualHeaders - Actual response headers
   * @param {object} expectedHeaders - Expected headers from contract
   * @returns {Array} Array of header validation issues
   */
  validateHeaders(actualHeaders, expectedHeaders) {
    const issues = [];

    for (const [headerName, headerSpec] of Object.entries(expectedHeaders)) {
      const actualValue = actualHeaders[headerName.toLowerCase()];

      if (headerSpec.required && !actualValue) {
        issues.push(this.createIssue(
          'missing_header',
          headerName,
          `Required header '${headerName}' is missing`
        ));
      }
    }

    return issues;
  }

  /**
   * Create validation result object
   * @param {string} path - Endpoint path
   * @param {string} method - HTTP method
   * @param {boolean} success - Whether validation passed
   * @param {number} statusCode - HTTP status code
   * @param {Array} issues - Validation issues
   * @param {object} metadata - Additional metadata
   * @returns {object} Validation result
   */
  createValidationResult(path, method, success, statusCode, issues, metadata = {}) {
    return {
      endpoint: path,
      method: method.toUpperCase(),
      success,
      statusCode,
      issues: issues || [],
      metadata,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create validation issue object
   * @param {string} type - Issue type
   * @param {string} field - Field that caused the issue
   * @param {string} message - Issue description
   * @param {object} metadata - Additional issue metadata
   * @returns {object} Validation issue
   */
  createIssue(type, field, message, metadata = {}) {
    return {
      type,
      field,
      message,
      metadata
    };
  }

  /**
   * Create result for endpoint not found in contract
   * @param {string} path - Endpoint path
   * @param {string} method - HTTP method
   * @returns {object} Validation result
   */
  createNotFoundResult(path, method) {
    return this.createValidationResult(path, method, false, null, [
      this.createIssue(
        'endpoint_not_found',
        null,
        `Endpoint ${method} ${path} not found in OpenAPI contract`
      )
    ]);
  }

  /**
   * Create result for network errors
   * @param {string} path - Endpoint path
   * @param {string} method - HTTP method
   * @param {Error} error - Network error
   * @returns {object} Validation result
   */
  createNetworkErrorResult(path, method, error) {
    return this.createValidationResult(path, method, false, null, [
      this.createIssue(
        'network_error',
        null,
        `Network error: ${error.message}`,
        { originalError: error.code || error.name }
      )
    ]);
  }

  /**
   * Get validator configuration
   * @returns {object} Current configuration
   */
  getConfig() {
    return {
      contractPath: this.contractPath,
      hasContract: !!this.contract,
      endpointCount: this.endpoints ? this.endpoints.length : 0,
      contractInfo: this.contract ? this.contract.info : null
    };
  }

  /**
   * Static method to calculate validation statistics (moved from original class)
   * @param {Array} results - Validation results
   * @returns {object} Statistics
   */
  static getValidationStats(results) {
    const stats = {
      total: results.length,
      passed: 0,
      failed: 0,
      errors: 0,
      totalIssues: 0,
      issuesByType: {},
      avgResponseTime: 0
    };

    let totalResponseTime = 0;
    let responseTimeCount = 0;

    results.forEach(result => {
      if (result.success) {
        stats.passed++;
      } else {
        stats.failed++;
      }

      stats.totalIssues += result.issues.length;

      // Count issues by type
      result.issues.forEach(issue => {
        stats.issuesByType[issue.type] = (stats.issuesByType[issue.type] || 0) + 1;
        if (issue.type === 'network_error' || issue.type === 'validation_failed') {
          stats.errors++;
        }
      });

      // Calculate average response time
      if (result.metadata && result.metadata.responseTime) {
        totalResponseTime += result.metadata.responseTime;
        responseTimeCount++;
      }
    });

    if (responseTimeCount > 0) {
      stats.avgResponseTime = Math.round(totalResponseTime / responseTimeCount);
    }

    // Calculate success rate
    stats.successRate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;

    return stats;
  }
}

export default APIValidator;