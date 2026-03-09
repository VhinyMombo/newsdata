import os
from dotenv import load_dotenv
from tavily import TavilyClient
from langchain_ollama.llms import OllamaLLM
from langchain.tools import tool
from langchain import hub
from langchain.agents import create_react_agent, AgentExecutor

load_dotenv()  # loads .env from the project root

model = OllamaLLM(model="llama3")
tavily_client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))


@tool
def internet_search(query: str) -> str:
    """Search the internet for up-to-date information on a given query."""
    return tavily_client.search(query)


@tool
def list_files() -> str:
    """List the files in the local Science directory."""
    directory = "/Users/vhinymombo/finres Dropbox/Science"
    if not os.path.exists(directory):
        return "Directory not found"
    return str(os.listdir(directory))


# Pull a standard ReAct prompt
prompt = hub.pull("hwchase17/react")

agent = create_react_agent(model, tools=[internet_search, list_files], prompt=prompt)
agent_executor = AgentExecutor(agent=agent, tools=[internet_search, list_files], verbose=True)

content = "where the codes of phenoDL are stored?"
result = agent_executor.invoke({"input": content})

print(result["output"])
