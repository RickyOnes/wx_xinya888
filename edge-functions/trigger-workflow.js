// Supabase Edge Function: trigger-workflow
// 用于触发GitHub Actions工作流

const GITHUB_API_BASE = 'https://api.github.com'
const DEFAULT_REPO_OWNER = 'RickyOnes' // 默认GitHub用户名，可从请求覆盖
const DEFAULT_REPO_NAME = 'wx_xinya888' // 默认仓库名，可从请求覆盖

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify API key (same as Supabase anon key)
    const authHeader = req.headers.get('authorization')
    const apiKey = Deno.env.get('SUPABASE_ANON_KEY')
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid authorization header' }),
        { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }
    
    const token = authHeader.replace('Bearer ', '')
    if (token !== apiKey) {
      return new Response(
        JSON.stringify({ error: 'Invalid API key' }),
        { 
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Parse request body
    const body = await req.json()
    const { 
      workflowName, 
      owner = DEFAULT_REPO_OWNER,
      repository = DEFAULT_REPO_NAME
    } = body
    
    if (!workflowName) {
      return new Response(
        JSON.stringify({ error: 'Missing workflowName parameter' }),
        { 
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Get GitHub token from environment variables
    const githubToken = Deno.env.get('GITHUB_TOKEN')
    if (!githubToken) {
      console.error('GITHUB_TOKEN environment variable is not set')
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { 
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Trigger GitHub Actions workflow
    // GitHub API expects workflow file name with extension
    // We'll try .yml first, then .yaml if needed
    const workflowUrl = `${GITHUB_API_BASE}/repos/${owner}/${repository}/actions/workflows/${workflowName}.yml/dispatches`
    
    const response = await fetch(workflowUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Supabase-Edge-Function'
      },
      body: JSON.stringify({
        ref: 'main' // 触发main分支的工作流
      })
    })

    // If .yml fails, try .yaml extension
    if (response.status === 404) {
      const workflowUrlYaml = `${GITHUB_API_BASE}/repos/${owner}/${repository}/actions/workflows/${workflowName}.yaml/dispatches`
      const responseYaml = await fetch(workflowUrlYaml, {
        method: 'POST',
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Supabase-Edge-Function'
        },
        body: JSON.stringify({
          ref: 'main'
        })
      })
      
      if (!responseYaml.ok) {
        const errorText = await responseYaml.text()
        console.error('GitHub API error (tried both .yml and .yaml):', responseYaml.status, errorText)
        return new Response(
          JSON.stringify({ 
            error: `Failed to trigger workflow: ${responseYaml.statusText}`,
            details: errorText
          }),
          { 
            status: responseYaml.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }
      
      // Return success response for .yaml
      return new Response(
        JSON.stringify({ 
          success: true,
          message: `Workflow ${workflowName} triggered successfully`,
          timestamp: new Date().toISOString(),
          extension: 'yaml'
        }),
        { 
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error('GitHub API error:', response.status, errorText)
      return new Response(
        JSON.stringify({ 
          error: `Failed to trigger workflow: ${response.statusText}`,
          details: errorText
        }),
        { 
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Return success response
    return new Response(
      JSON.stringify({ 
        success: true,
        message: `Workflow ${workflowName} triggered successfully`,
        timestamp: new Date().toISOString(),
        extension: 'yml'
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})