# Use a highly optimized, minimal Node environment base image
FROM node:20-alpine

# Set the operational directory inside the container
WORKDIR /app

# Copy the dependencies map first to optimize layer caching
COPY package.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the actual processing script code
COPY sanitize.js ./

# Crucial Security Step: Switch from the administrator 'root' user 
# to a generic, restricted 'node' user to trap any system breakouts
USER node

# Instruct the container to execute our script by default
CMD ["node", "sanitize.js"]