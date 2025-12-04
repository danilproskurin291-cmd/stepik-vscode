# Stepik for VS Code

Solve [Stepik](https://stepik.org) problems directly in VS Code.


## Build
```
npm install -g vsce
vsce package
code --install-extension stepik-vscode-*.vsix
```


## OAuth Setup

1. Go to https://stepik.org/oauth2/applications/ and create a new application with settings `client type = confidential` and `authorization grant type = client-credentials`. 
2. Next, from the same page one has to copy the `client id` and `client secret` of the new app. 
3. These settings must be pasted to extension.




## Workspace

Solutions are saved in `~/.stepik` by default, organized by course and lesson.

## License

GPL v3
Study and solve Stepik lessons and exercises using VS Code.


