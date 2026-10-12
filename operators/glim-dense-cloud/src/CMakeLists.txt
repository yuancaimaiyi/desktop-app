cmake_minimum_required(VERSION 3.5.2)
project(glim_dense_cloud_builder)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_BUILD_TYPE Release)

find_package(glim REQUIRED)
find_package(PCL 1.10 REQUIRED COMPONENTS common io filters)

include_directories(${PCL_INCLUDE_DIRS})
link_directories(${PCL_LIBRARY_DIRS})
add_definitions(${PCL_DEFINITIONS})

add_executable(build_dense_cloud build_dense_cloud.cpp)
target_link_libraries(build_dense_cloud
  glim::glim
  ${PCL_LIBRARIES}
)
